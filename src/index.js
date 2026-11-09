// Cloudflare Worker that shows Google Classroom assignments for several people.
// It never talks to Google: the Chrome extension in ../extension scrapes Classroom in each
// person's own browser and POSTs the results here.
//
// People: the owner logs in with the ACCESS_KEY secret and manages everyone else at /admin.
// Each person gets their own random key; only a SHA-256 hash of it is stored.
//
// KV layout:
//   users                  -> [{ id, name, keyHash, created }]   (list for the admin page)
//   user:<keyHash>         -> { id, name }                        (key lookup)
//   u:<id>:assigned        -> { scrapedAt, items }                (To-do list)
//   u:<id>:details         -> { <link>: { description, attachments, work, ... } }
//   u:<id>:hidden          -> [link, ...]
//   u:<id>:debug:<name>    -> page outline for fixing the scraper (7-day expiry)

const COOKIE_TTL = 60 * 60 * 24 * 90; // stay logged in for 90 days
const OWNER = "owner";
// The free plan allows ~1,000 KV writes a day for everyone together, so unchanged data is
// only rewritten (to refresh "Synced … ago") at most once an hour.
const REFRESH_MS = 60 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    try {
      if (!env.ACCESS_KEY) throw new Error("ACCESS_KEY secret is not set.");
      switch (route) {
        case "POST /api/ingest": return await ingest(request, env);
        case "POST /api/details": return await ingestDetails(request, env);
        case "POST /api/debug": return await saveDebug(request, env);
        case "GET /api/debug": return await getDebug(request, url, env);
        case "POST /api/hide": return await hide(request, env);
        case "GET /api/assignments": return await apiAll(request, env);
        case "GET /api/me": return await apiMe(request, env);
        case "POST /login": return await login(request, env);
        case "GET /logout": return logout();
        case "GET /": return await home(request, env);
        case "GET /admin": return await adminPage(request, env);
        case "POST /admin": return await adminAction(request, env);
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(err);
      return new Response(`Error: ${err.message || err}`, { status: 500, headers: { "Content-Type": "text/plain" } });
    }
  },
};

// ---------------------------------------------------------------- people & auth

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const newKey = () => {
  const b = new Uint8Array(15);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "x").replace(/\//g, "y").replace(/=+$/, "");
};
const newId = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");

// Look a person up by the hash of their key.
async function userByHash(hash, env) {
  if (!hash) return null;
  if (hash === (await sha256(env.ACCESS_KEY))) return { id: OWNER, name: env.OWNER_NAME || "Owner", admin: true };
  const u = await env.KV.get(`user:${hash}`, "json");
  return u ? { ...u, admin: false } : null;
}

// From the extension (Authorization: Bearer <key>) or the website (cookie holding the key's hash).
async function currentUser(request, env) {
  const h = request.headers.get("Authorization") || "";
  if (h.startsWith("Bearer ")) return userByHash(await sha256(h.slice(7).trim()), env);
  return userByHash(getCookie(request, "auth"), env);
}

async function login(request, env) {
  const form = await request.formData();
  const key = String(form.get("key") || "").trim();
  const hash = await sha256(key);
  if (!key || !(await userByHash(hash, env))) return html(loginPage("That key didn't work. Check it and try again."), 401);
  return new Response(null, {
    status: 303,
    headers: { Location: "/", "Set-Cookie": `auth=${hash}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_TTL}` },
  });
}

function logout() {
  return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": "auth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" } });
}

// ---------------------------------------------------------------- storage

const str = (v, n) => String(v ?? "").slice(0, n);
const httpUrl = (u) => (/^https?:\/\//i.test(u || "") ? str(u, 2000) : "");
const classroomUrl = (u) => (/^https:\/\/classroom\.google\.com\//.test(u || "") ? str(u, 500) : "");
const k = (user, name) => `u:${user.id}:${name}`;

function cleanAttachments(list) {
  return (Array.isArray(list) ? list : []).slice(0, 30).map((a) => ({
    name: str(a.name, 200), url: httpUrl(a.url), kind: str(a.kind, 20), sub: str(a.sub, 120),
  })).filter((a) => a.url);
}

const unauthorized = () => json({ error: "Unknown key. Check the key in the extension popup." }, 401);

async function ingest(request, env) {
  const user = await currentUser(request, env);
  if (!user) return unauthorized();
  const body = await request.json();
  if (!Array.isArray(body.items)) return json({ error: "items must be an array" }, 400);
  const items = body.items.slice(0, 500).map((i) => ({
    title: str(i.title, 300),
    course: str(i.course, 200),
    dueText: str(i.dueText, 100),
    posted: str(i.posted, 100),
    postedAt: i.postedAt && !isNaN(Date.parse(i.postedAt)) ? new Date(i.postedAt).toISOString() : null,
    due: i.due && !isNaN(Date.parse(i.due)) ? new Date(i.due).toISOString() : null,
    link: classroomUrl(i.link),
    lines: Array.isArray(i.lines) ? i.lines.slice(0, 10).map((l) => str(l, 200)) : [],
  }));

  const prev = await env.KV.get(k(user, "assigned"), "json");
  const same = prev && JSON.stringify(prev.items) === JSON.stringify(items);
  if (same && Date.now() - Date.parse(prev.scrapedAt) < REFRESH_MS) return json({ ok: true, count: items.length, unchanged: true });
  await env.KV.put(k(user, "assigned"), JSON.stringify({ scrapedAt: new Date().toISOString(), items }));
  return json({ ok: true, count: items.length });
}

async function ingestDetails(request, env) {
  const user = await currentUser(request, env);
  if (!user) return unauthorized();
  const body = await request.json();
  const details = (await env.KV.get(k(user, "details"), "json")) || {};
  let changed = false;
  for (const d of (body.items || []).slice(0, 100)) {
    const link = classroomUrl(d.link);
    if (!link) continue;
    const entry = {
      title: str(d.title, 300),
      teacher: str(d.teacher, 100),
      dueText: str(d.dueText, 100),
      points: str(d.points, 40),
      description: str(d.description, 8000),
      attachments: cleanAttachments(d.attachments),
      work: d.work ? { status: str(d.work.status, 40), attachments: cleanAttachments(d.work.attachments) } : null,
    };
    const old = details[link];
    const { fetchedAt, ...oldContent } = old || {};
    // Rewrite only if something changed, or to keep it from expiring below.
    if (!old || JSON.stringify(oldContent) !== JSON.stringify(entry) || Date.now() - Date.parse(fetchedAt) > 7 * 86400e3) {
      details[link] = { fetchedAt: new Date().toISOString(), ...entry };
      changed = true;
    }
  }
  // Forget details for assignments not seen in 60 days so the blob stays small.
  const cutoff = Date.now() - 60 * 86400e3;
  for (const [key, v] of Object.entries(details)) if (Date.parse(v.fetchedAt) < cutoff) { delete details[key]; changed = true; }
  if (changed) await env.KV.put(k(user, "details"), JSON.stringify(details));
  return json({ ok: true, changed });
}

async function saveDebug(request, env) {
  const user = await currentUser(request, env);
  if (!user) return unauthorized();
  const { name, text } = await request.json();
  if (!/^[\w-]{1,40}$/.test(name || "")) return json({ error: "bad name" }, 400);
  await env.KV.put(k(user, `debug:${name}`), str(text, 1_000_000), { expirationTtl: 7 * 86400 });
  return json({ ok: true });
}

async function getDebug(request, url, env) {
  const user = await currentUser(request, env);
  if (!user) return unauthorized();
  // The owner can read anyone's outline (?user=<id>) to fix the scraper for them.
  const id = user.admin && url.searchParams.get("user") ? url.searchParams.get("user") : user.id;
  const text = await env.KV.get(`u:${id}:debug:${url.searchParams.get("name") || ""}`);
  return new Response(text ?? "none", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

async function hide(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: "not logged in" }, 401);
  const { link, hidden } = await request.json();
  if (!classroomUrl(link)) return json({ error: "bad link" }, 400);
  const set = new Set((await env.KV.get(k(user, "hidden"), "json")) || []);
  hidden ? set.add(link) : set.delete(link);
  await env.KV.put(k(user, "hidden"), JSON.stringify([...set]));
  return json({ ok: true });
}

async function loadAll(user, env) {
  const [assigned, details, hidden] = await Promise.all([
    env.KV.get(k(user, "assigned"), "json"),
    env.KV.get(k(user, "details"), "json"),
    env.KV.get(k(user, "hidden"), "json"),
  ]);
  return { assigned, details: details || {}, hidden: hidden || [] };
}

async function apiAll(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: "not logged in" }, 401);
  return json(await loadAll(user, env));
}

// The extension calls this to check a key and greet the person by name.
async function apiMe(request, env) {
  const user = await currentUser(request, env);
  if (!user) return unauthorized();
  return json({ name: user.name });
}

async function home(request, env) {
  const user = await currentUser(request, env);
  if (!user) return html(loginPage());
  const data = await loadAll(user, env);
  data.tz = env.TIMEZONE || "America/New_York";
  data.name = user.name;
  data.admin = user.admin;
  return html(appPage(data));
}

// ---------------------------------------------------------------- admin

async function listUsers(env) {
  return (await env.KV.get("users", "json")) || [];
}

async function adminPage(request, env, flash = null) {
  const user = await currentUser(request, env);
  if (!user) return html(loginPage());
  if (!user.admin) return new Response("Only the site owner can open this page.", { status: 403 });

  const users = [{ id: OWNER, name: `${user.name} (you)`, owner: true }, ...(await listUsers(env))];
  const snaps = await Promise.all(users.map((u) => env.KV.get(`u:${u.id}:assigned`, "json")));
  const origin = new URL(request.url).origin;
  return html(adminHtml(users, snaps, flash, origin));
}

async function adminAction(request, env) {
  const user = await currentUser(request, env);
  if (!user?.admin) return new Response("Only the site owner can do this.", { status: 403 });
  const form = await request.formData();
  const action = form.get("action");
  const users = await listUsers(env);

  if (action === "add") {
    const name = str(form.get("name"), 60).trim();
    if (!name) return adminPage(request, env, { error: "Type a name first." });
    const key = newKey();
    const keyHash = await sha256(key);
    const u = { id: newId(), name, keyHash, created: new Date().toISOString() };
    await env.KV.put(`user:${keyHash}`, JSON.stringify({ id: u.id, name }));
    await env.KV.put("users", JSON.stringify([...users, u]));
    return adminPage(request, env, { name, key });
  }

  const u = users.find((x) => x.id === form.get("id"));
  if (!u) return adminPage(request, env, { error: "That person wasn't found." });

  if (action === "reset") {
    const key = newKey();
    const keyHash = await sha256(key);
    await env.KV.delete(`user:${u.keyHash}`);
    await env.KV.put(`user:${keyHash}`, JSON.stringify({ id: u.id, name: u.name }));
    u.keyHash = keyHash;
    await env.KV.put("users", JSON.stringify(users));
    return adminPage(request, env, { name: u.name, key, reset: true });
  }

  if (action === "remove") {
    await env.KV.delete(`user:${u.keyHash}`);
    await Promise.all(["assigned", "details", "hidden"].map((n) => env.KV.delete(`u:${u.id}:${n}`)));
    await env.KV.put("users", JSON.stringify(users.filter((x) => x.id !== u.id)));
    return adminPage(request, env, { removed: u.name });
  }
  return adminPage(request, env, { error: "Unknown action." });
}

// ---------------------------------------------------------------- helpers

function html(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function getCookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

// ---------------------------------------------------------------- pages

const HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f7f7f5" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121214" media="(prefers-color-scheme: dark)">
<title>Assignments</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23376a5f'/%3E%3Cpath d='M9 16.5l4.5 4.5L23 11.5' stroke='white' stroke-width='3' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">`;

const CSS = `
:root {
  --bg:#f7f7f5; --surface:#ffffff; --surface-2:#f1f1ee; --text:#18181b; --text-2:#52525b; --text-3:#8a8a93;
  --line:#e7e7e3; --line-2:#d9d9d4; --accent:#376a5f; --accent-soft:#e3eeeb; --accent-text:#ffffff;
  --red:#c2410c; --red-soft:#fdebe2; --amber:#a16207; --amber-soft:#fbf1d9;
  --shadow:0 1px 2px rgba(16,16,20,.04), 0 1px 1px rgba(16,16,20,.03);
  --shadow-lg:0 24px 64px -12px rgba(16,16,20,.25), 0 2px 6px rgba(16,16,20,.06);
  --radius:14px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:#121214; --surface:#1a1a1d; --surface-2:#222226; --text:#f4f4f5; --text-2:#b4b4bb; --text-3:#7c7c85;
    --line:#2a2a2f; --line-2:#36363c; --accent:#7cc4b2; --accent-soft:#1f302c; --accent-text:#0d1a17;
    --red:#fb8a5c; --red-soft:#3a2219; --amber:#e8b64c; --amber-soft:#352b15;
    --shadow:0 1px 2px rgba(0,0,0,.3); --shadow-lg:0 24px 64px -12px rgba(0,0,0,.7);
  }
}
* { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing:antialiased; font-feature-settings:"cv11","ss01"; }
button { font:inherit; color:inherit; background:none; border:0; padding:0; cursor:pointer; }
a { color:inherit; }
svg { display:block; flex-shrink:0; }
.wrap { max-width:760px; margin:0 auto; padding:28px 20px 80px; }
`;

function loginPage(msg = "") {
  return `<!doctype html><html lang="en"><head>${HEAD}<style>${CSS}
  .login { min-height:100vh; display:grid; place-items:center; padding:20px; }
  .box { width:100%; max-width:360px; background:var(--surface); border:1px solid var(--line); border-radius:18px; padding:32px 28px; box-shadow:var(--shadow); }
  .mark { width:40px; height:40px; border-radius:11px; background:var(--accent); display:grid; place-items:center; margin-bottom:20px; }
  h1 { font-size:20px; letter-spacing:-.01em; margin:0 0 6px; }
  p { color:var(--text-2); margin:0 0 22px; font-size:14px; }
  input { width:100%; font:inherit; padding:11px 13px; border-radius:10px; border:1px solid var(--line-2); background:var(--bg); color:var(--text); outline:none; }
  input:focus { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
  .go { width:100%; margin-top:12px; background:var(--accent); color:var(--accent-text); font-weight:600; padding:11px; border-radius:10px; }
  .err { color:var(--red); font-size:13px; margin:-10px 0 14px; }
  </style></head><body><div class="login"><form class="box" method="post" action="/login">
    <div class="mark"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
    <h1>Assignments</h1>
    <p>Enter your key to see your assignments.</p>
    ${msg ? `<div class="err">${esc(msg)}</div>` : ""}
    <input type="password" name="key" placeholder="Your key" autocomplete="current-password" autofocus required>
    <button class="go" type="submit">Continue</button>
  </form></div></body></html>`;
}

function adminHtml(users, snaps, flash, origin) {
  const ago = (iso) => {
    if (!iso) return "Never synced";
    const m = Math.round((Date.now() - Date.parse(iso)) / 6e4);
    if (m < 60) return `Synced ${m < 1 ? "just now" : m + " min ago"}`;
    const h = Math.round(m / 60);
    return `Synced ${h < 48 ? h + " hr" : Math.round(h / 24) + " days"} ago`;
  };
  const invite = flash?.key ? `Here's your key for the Google Classroom assignments site: ${flash.key}

1. Download the extension: https://github.com/faarisaahmed/gclass (green Code button > Download ZIP, then unzip it)
2. In Chrome go to chrome://extensions, turn on Developer mode, click Load unpacked, and pick the "extension" folder
3. Click the extension icon, paste your key, click Save, then Sync now
4. See your assignments at ${origin}` : "";

  let banner = "";
  if (flash?.error) banner = `<div class="flash err">${esc(flash.error)}</div>`;
  else if (flash?.removed) banner = `<div class="flash">Removed ${esc(flash.removed)}.</div>`;
  else if (flash?.key) banner = `<div class="flash ok">
      <b>${flash.reset ? "New key for" : "Added"} ${esc(flash.name)}.</b> Send them this message. The key is only shown once.
      <textarea id="inv" readonly rows="8">${esc(invite)}</textarea>
      <button class="go" type="button" onclick="navigator.clipboard.writeText(document.getElementById('inv').value).then(()=>this.textContent='Copied')">Copy message</button>
    </div>`;

  const rows = users.map((u, i) => `
    <div class="urow">
      <div class="who"><b>${esc(u.name)}</b><span>${esc(ago(snaps[i]?.scrapedAt))}${snaps[i] ? ` &middot; ${snaps[i].items.length} assignments` : ""}</span></div>
      ${u.owner ? '<span class="tag">Owner</span>' : `
      <form method="post"><input type="hidden" name="action" value="reset"><input type="hidden" name="id" value="${esc(u.id)}">
        <button class="small" onclick="return confirm('Make a new key for ${esc(u.name).replace(/'/g, "")}? Their old key stops working.')">New key</button></form>
      <form method="post"><input type="hidden" name="action" value="remove"><input type="hidden" name="id" value="${esc(u.id)}">
        <button class="small danger" onclick="return confirm('Remove ${esc(u.name).replace(/'/g, "")} and delete their data?')">Remove</button></form>`}
    </div>`).join("");

  return `<!doctype html><html lang="en"><head>${HEAD}<style>${CSS}
  .top { display:flex; justify-content:space-between; align-items:center; margin-bottom:24px; }
  h1 { font-size:26px; letter-spacing:-.02em; margin:0; }
  .back { font-size:14px; color:var(--text-2); text-decoration:none; padding:7px 12px; border:1px solid var(--line); border-radius:9px; background:var(--surface); }
  .card { background:var(--surface); border:1px solid var(--line); border-radius:14px; box-shadow:var(--shadow); margin-bottom:18px; }
  .pad { padding:18px; }
  h2 { font-size:13px; font-weight:600; color:var(--text-2); margin:0 0 10px 2px; }
  .add { display:flex; gap:8px; }
  input[type=text] { flex:1; min-width:0; font:inherit; padding:10px 12px; border-radius:10px; border:1px solid var(--line-2); background:var(--bg); color:var(--text); outline:none; }
  input[type=text]:focus { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
  .go { background:var(--accent); color:var(--accent-text); font-weight:600; padding:10px 16px; border-radius:10px; }
  .urow { display:flex; align-items:center; gap:8px; padding:13px 16px; }
  .urow + .urow { border-top:1px solid var(--line); }
  .who { flex:1; min-width:0; } .who b { display:block; font-weight:600; } .who span { font-size:13px; color:var(--text-3); }
  .small { font-size:13px; padding:6px 10px; border-radius:8px; border:1px solid var(--line); color:var(--text-2); }
  .small:hover { background:var(--surface-2); } .danger { color:var(--red); }
  .tag { font-size:12px; color:var(--text-3); padding:4px 9px; border-radius:999px; background:var(--surface-2); }
  .flash { padding:14px 16px; border-radius:12px; margin-bottom:18px; background:var(--surface-2); font-size:14px; }
  .flash.ok { background:var(--accent-soft); } .flash.err { background:var(--red-soft); color:var(--red); }
  .flash textarea { display:block; width:100%; margin:10px 0; font:13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; padding:10px; border-radius:9px; border:1px solid var(--line-2); background:var(--surface); color:var(--text); resize:vertical; }
  .note { font-size:13px; color:var(--text-3); margin:6px 2px 0; }
  </style></head><body><div class="wrap">
    <div class="top"><h1>People</h1><a class="back" href="/">Back to assignments</a></div>
    ${banner}
    <h2>Add someone</h2>
    <form class="card pad add" method="post"><input type="hidden" name="action" value="add">
      <input type="text" name="name" placeholder="Their name" maxlength="60" required><button class="go">Create key</button></form>
    <h2>Everyone (${users.length})</h2>
    <div class="card">${rows}</div>
    <p class="note">Each person only sees their own assignments. You can't see theirs here, only when they last synced.</p>
  </div></body></html>`;
}

function appPage(data) {
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head>${HEAD}<style>${CSS}${APP_CSS}</style></head>
<body>
<div class="wrap">
  <header class="top">
    <div>
      <h1>${data.name && !data.admin ? esc(data.name.split(" ")[0]) + "'s assignments" : "Assignments"}</h1>
      <div class="sync" id="sync"></div>
    </div>
    <div class="acts">${data.admin ? '<a class="ghost" href="/admin">People</a>' : ""}<a class="ghost" href="/logout">Log out</a></div>
  </header>
  <nav class="tabs" id="tabs" role="tablist">
    <button role="tab" data-tab="upcoming">Upcoming <span class="n"></span></button>
    <button role="tab" data-tab="all">All <span class="n"></span></button>
    <button role="tab" data-tab="hidden">Hidden <span class="n"></span></button>
  </nav>
  <div class="tools" id="tools">
    <div class="search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="q" placeholder="Search assignments" autocomplete="off"></div>
    <div class="chips" id="chips"></div>
  </div>
  <main id="list"></main>
</div>
<div class="scrim" id="scrim"></div>
<aside class="drawer" id="drawer" aria-hidden="true"></aside>
<div class="toast" id="toast"></div>
<script id="data" type="application/json">${payload}</script>
<script>${APP_JS}</script>
</body></html>`;
}

const APP_CSS = `
.top { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:22px; }
.top h1 { font-size:28px; font-weight:700; letter-spacing:-.025em; margin:0; }
.sync { display:flex; align-items:center; gap:7px; color:var(--text-3); font-size:13px; margin-top:4px; }
.dot { width:7px; height:7px; border-radius:50%; background:var(--accent); }
.dot.stale { background:var(--amber); }
.ghost { font-size:13px; color:var(--text-2); text-decoration:none; padding:7px 12px; border-radius:9px; border:1px solid var(--line); background:var(--surface); }
.ghost:hover { border-color:var(--line-2); }
.acts { display:flex; gap:8px; }

.tabs { display:flex; gap:4px; padding:4px; background:var(--surface-2); border-radius:12px; width:fit-content; margin-bottom:16px; }
.tabs button { padding:7px 14px; border-radius:9px; font-size:14px; font-weight:500; color:var(--text-2); display:flex; align-items:center; gap:7px; }
.tabs button[aria-selected=true] { background:var(--surface); color:var(--text); box-shadow:var(--shadow); }
.tabs .n { font-size:12px; color:var(--text-3); font-variant-numeric:tabular-nums; }
.tabs .n:empty { display:none; }

.tools { display:none; flex-direction:column; gap:10px; margin-bottom:18px; }
.tools.on { display:flex; }
.search { display:flex; align-items:center; gap:9px; background:var(--surface); border:1px solid var(--line); border-radius:11px; padding:0 13px; color:var(--text-3); }
.search:focus-within { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
.search input { flex:1; border:0; outline:0; background:none; font:inherit; color:var(--text); padding:10px 0; min-width:0; }
.chips { display:flex; gap:6px; flex-wrap:wrap; }
.chip { font-size:13px; padding:5px 11px; border-radius:999px; border:1px solid var(--line); background:var(--surface); color:var(--text-2); display:flex; align-items:center; gap:6px; }
.chip[aria-pressed=true] { background:var(--text); border-color:var(--text); color:var(--bg); }
.chip i { width:8px; height:8px; border-radius:50%; }

.group { margin-bottom:26px; }
.gh { display:flex; align-items:baseline; gap:8px; margin:0 2px 9px; }
.gh h2 { font-size:13px; font-weight:600; margin:0; color:var(--text-2); letter-spacing:.01em; }
.gh .c { font-size:12px; color:var(--text-3); font-variant-numeric:tabular-nums; }
.gh.red h2 { color:var(--red); }
.card { background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); box-shadow:var(--shadow); overflow:hidden; }
.row { position:relative; display:flex; align-items:center; gap:14px; padding:13px 10px 13px 16px; cursor:pointer; transition:background .12s; }
.row + .row { border-top:1px solid var(--line); }
.row:hover { background:var(--surface-2); }
.bar { width:3px; align-self:stretch; border-radius:3px; }
.body { flex:1; min-width:0; }
.t { font-weight:600; font-size:15px; line-height:1.35; overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
.sub { font-size:13px; color:var(--text-3); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.when { text-align:right; flex-shrink:0; }
.when b { display:block; font-size:13px; font-weight:600; font-variant-numeric:tabular-nums; }
.when span { display:block; font-size:12px; color:var(--text-3); }
.when.red b { color:var(--red); }
.when.amber b { color:var(--amber); }
.when.muted b { color:var(--text-3); font-weight:500; }
.x { width:30px; height:30px; border-radius:8px; display:grid; place-items:center; color:var(--text-3); flex-shrink:0; opacity:0; transition:opacity .12s, background .12s; }
.row:hover .x, .x:focus-visible { opacity:1; }
.x:hover { background:var(--line); color:var(--text); }
@media (hover:none) { .x { opacity:1; } }
.restore { font-size:13px; font-weight:500; color:var(--accent); padding:6px 10px; border-radius:8px; flex-shrink:0; }
.restore:hover { background:var(--accent-soft); }

.empty { text-align:center; padding:56px 20px; color:var(--text-3); }
.empty b { display:block; color:var(--text); font-size:16px; font-weight:600; margin-bottom:4px; }
.empty .ring { width:44px; height:44px; border-radius:50%; background:var(--accent-soft); color:var(--accent); display:grid; place-items:center; margin:0 auto 14px; }

.scrim { position:fixed; inset:0; background:rgba(10,10,12,.32); opacity:0; pointer-events:none; transition:opacity .2s; z-index:10; }
.scrim.on { opacity:1; pointer-events:auto; }
.drawer { position:fixed; top:0; right:0; bottom:0; width:min(520px,100%); background:var(--surface); box-shadow:var(--shadow-lg); transform:translateX(100%); transition:transform .26s cubic-bezier(.2,.8,.2,1); z-index:11; overflow-y:auto; overscroll-behavior:contain; }
.drawer.on { transform:none; }
.dh { position:sticky; top:0; display:flex; justify-content:space-between; align-items:center; padding:14px 16px 14px 24px; background:var(--surface); border-bottom:1px solid var(--line); z-index:1; }
.course { display:flex; align-items:center; gap:8px; font-size:13px; font-weight:500; color:var(--text-2); min-width:0; }
.course i { width:9px; height:9px; border-radius:50%; flex-shrink:0; }
.course span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.close { width:34px; height:34px; border-radius:9px; display:grid; place-items:center; color:var(--text-2); }
.close:hover { background:var(--surface-2); }
.db { padding:22px 24px 40px; }
.db h2 { font-size:22px; line-height:1.3; letter-spacing:-.015em; margin:0 0 14px; font-weight:700; }
.meta { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:20px; }
.pill { font-size:12.5px; font-weight:500; padding:4px 10px; border-radius:999px; background:var(--surface-2); color:var(--text-2); display:flex; align-items:center; gap:6px; }
.pill.red { background:var(--red-soft); color:var(--red); }
.pill.amber { background:var(--amber-soft); color:var(--amber); }
.pill.green { background:var(--accent-soft); color:var(--accent); }
.primary { display:flex; align-items:center; justify-content:center; gap:8px; width:100%; background:var(--accent); color:var(--accent-text); text-decoration:none; font-weight:600; font-size:14.5px; padding:12px; border-radius:11px; transition:filter .12s; }
.primary:hover { filter:brightness(1.07); }
.sec { margin-top:28px; }
.sec h3 { font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; color:var(--text-3); margin:0 0 10px; }
.desc { white-space:pre-wrap; word-wrap:break-word; font-size:14.5px; line-height:1.65; color:var(--text); }
.desc a { color:var(--accent); }
.files { display:grid; gap:8px; }
.file { display:flex; align-items:center; gap:12px; padding:10px 12px; border:1px solid var(--line); border-radius:12px; text-decoration:none; transition:border-color .12s, background .12s; }
.file:hover { border-color:var(--line-2); background:var(--surface-2); }
.ic { width:36px; height:36px; border-radius:9px; display:grid; place-items:center; font-size:10px; font-weight:700; letter-spacing:.03em; color:#fff; flex-shrink:0; }
.ic.doc { background:#3b6fd8; } .ic.sheet { background:#1f8a4c; } .ic.slides { background:#d99a0b; } .ic.form { background:#7048c6; }
.ic.pdf { background:#d0412f; } .ic.video { background:#c4302b; } .ic.drive { background:#5f6b7a; } .ic.link { background:var(--text-3); }
.fn { flex:1; min-width:0; }
.fn b { display:block; font-size:14px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fn span { display:block; font-size:12px; color:var(--text-3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.work { background:var(--surface-2); border-radius:14px; padding:16px; }
.work .wh { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
.work .wh b { font-size:15px; font-weight:600; }
.work .file { background:var(--surface); }
.note { font-size:13px; color:var(--text-3); }
.muted-box { border:1px dashed var(--line-2); border-radius:12px; padding:16px; font-size:13.5px; color:var(--text-3); }
.hidebtn { margin-top:28px; width:100%; padding:11px; border-radius:11px; border:1px solid var(--line); font-size:14px; font-weight:500; color:var(--text-2); }
.hidebtn:hover { background:var(--surface-2); }

.toast { position:fixed; left:50%; bottom:24px; transform:translate(-50%,20px); background:var(--text); color:var(--bg); padding:10px 10px 10px 16px; border-radius:12px; font-size:14px; display:flex; align-items:center; gap:14px; opacity:0; pointer-events:none; transition:all .2s; z-index:20; box-shadow:var(--shadow-lg); }
.toast.on { opacity:1; transform:translate(-50%,0); pointer-events:auto; }
.toast button { font-weight:600; padding:5px 10px; border-radius:8px; color:var(--accent); background:rgba(127,127,127,.15); }

@media (max-width:600px) {
  .wrap { padding:20px 14px 80px; }
  .top h1 { font-size:24px; }
  .tabs { width:100%; } .tabs button { flex:1; justify-content:center; }
  .row { padding:12px 6px 12px 13px; gap:11px; }
  .db { padding:20px 18px 40px; }
  .dh { padding:12px 10px 12px 18px; }
}
`;

const APP_JS = `
const D = JSON.parse(document.getElementById("data").textContent);
const TZ = D.tz;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);

const ICON = {
  x: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  ext: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  check: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
};
const KIND = { doc:"DOC", sheet:"XLS", slides:"PPT", form:"FORM", pdf:"PDF", video:"VID", drive:"FILE", link:"URL" };

// ---- data
const PALETTE = ["#4a7be6","#2b9a5a","#e0662e","#8b5cf6","#1b98b5","#d9468a","#c99a16","#6a9a1f","#d64545","#64748b"];
function colorFor(name) { let h = 0; for (const c of name || "") h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; }

const hidden = new Set(D.hidden);
const items = [];
const seen = new Set();
// Not shown: anything already past due, and no-due-date work posted more than a week ago.
const NOW0 = Date.now(), WEEK = 7 * 864e5;
function relevant(it) {
  if (it.due) return Date.parse(it.due) >= NOW0;
  return !it.postedAt || Date.parse(it.postedAt) >= NOW0 - WEEK;
}
for (const it of D.assigned?.items || []) {
  const key = it.link || it.title;
  if (seen.has(key) || !relevant(it)) continue;
  seen.add(key);
  const det = D.details[it.link] || null;
  items.push({ ...it, key, status: "assigned", det, color: colorFor(it.course) });
}
items.forEach((it, i) => it.id = i);

// ---- dates
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit" });
const dayKey = (d) => dayFmt.format(d);
const fTime = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour:"numeric", minute:"2-digit" });
const fDay = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday:"short", month:"short", day:"numeric" });
const fWeekday = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday:"long" });
const fLong = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday:"long", month:"long", day:"numeric", hour:"numeric", minute:"2-digit" });

function bucket(it, now) {
  if (!it.due) return "none";
  const d = new Date(it.due);
  if (d < now) return "past";
  const k = dayKey(d), today = dayKey(now), tom = dayKey(new Date(+now + 864e5)), wk = dayKey(new Date(+now + 7 * 864e5));
  if (k === today) return "today";
  if (k === tom) return "tomorrow";
  if (k <= wk) return "week";
  return "later";
}

function whenParts(it, now) {
  if (!it.due) return { main: it.dueText ? it.dueText.replace(/^Due\\s*/i, "") : "No due date", sub: (it.posted || "").replace(/^Posted\\s+(\\w+day,\\s*)?/i, "Posted "), tone: "muted" };
  const d = new Date(it.due), b = bucket(it, now);
  const days = Math.round((new Date(dayKey(d)) - new Date(dayKey(now))) / 864e5);
  if (b === "missing") return { main: fDay.format(d), sub: days === 0 ? "Earlier today" : days === -1 ? "Yesterday" : -days + " days late", tone: "red" };
  if (b === "today") return { main: fTime.format(d), sub: "Today", tone: "amber" };
  if (b === "tomorrow") return { main: fTime.format(d), sub: "Tomorrow", tone: "" };
  if (b === "week") return { main: fWeekday.format(d), sub: fDay.format(d).split(", ")[1], tone: "" };
  return { main: fDay.format(d), sub: "In " + days + " days", tone: "" };
}

function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 6e4);
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  const h = Math.round(m / 60);
  return h < 48 ? h + " hr ago" : Math.round(h / 24) + " days ago";
}

// ---- state
let tab = (() => { try { return localStorage.getItem("tab") || "upcoming"; } catch { return "upcoming"; } })();
let query = "", course = "";

// ---- rendering
function row(it, now) {
  const w = whenParts(it, now);
  const isHidden = hidden.has(it.key);
  return '<div class="row" data-id="' + it.id + '" tabindex="0">' +
    '<div class="bar" style="background:' + it.color + '"></div>' +
    '<div class="body"><div class="t">' + esc(it.title || "Untitled") + '</div><div class="sub">' + esc(it.course) + '</div></div>' +
    '<div class="when ' + w.tone + '"><b>' + esc(w.main) + '</b>' + (w.sub ? '<span>' + esc(w.sub) + '</span>' : '') + '</div>' +
    (isHidden
      ? '<button class="restore" data-restore="' + it.id + '">Restore</button>'
      : '<button class="x" data-hide="' + it.id + '" aria-label="Hide" title="Hide">' + ICON.x + '</button>') +
    '</div>';
}

function group(title, list, now, cls) {
  if (!list.length) return "";
  return '<section class="group"><div class="gh ' + (cls || "") + '"><h2>' + title + '</h2><span class="c">' + list.length + '</span></div>' +
    '<div class="card">' + list.map((it) => row(it, now)).join("") + '</div></section>';
}

function empty(title, sub) {
  return '<div class="empty"><div class="ring">' + ICON.check + '</div><b>' + title + '</b>' + sub + '</div>';
}

const byDue = (a, b) => (a.due || "9999").localeCompare(b.due || "9999") || a.title.localeCompare(b.title);

function render() {
  const now = new Date();
  const visible = items.filter((it) => !hidden.has(it.key) && bucket(it, now) !== "past");
  const upcoming = visible.filter((it) => bucket(it, now) !== "none");

  document.querySelectorAll("#tabs button").forEach((b) => {
    b.setAttribute("aria-selected", b.dataset.tab === tab);
    const n = { upcoming: upcoming.length, all: visible.length, hidden: items.length - visible.length }[b.dataset.tab];
    b.querySelector(".n").textContent = n || "";
  });
  $("#tools").classList.toggle("on", tab === "all");

  let html = "";
  if (tab === "upcoming") {
    const g = { today: [], tomorrow: [], week: [], later: [] };
    upcoming.sort(byDue).forEach((it) => g[bucket(it, now)].push(it));
    html = group("Due today", g.today, now) + group("Tomorrow", g.tomorrow, now) +
      group("This week", g.week, now) + group("Later", g.later, now);
    if (!html) html = empty("You're all caught up", "Nothing with a due date is waiting on you.");
  } else if (tab === "all") {
    const courses = [...new Set(visible.map((i) => i.course).filter(Boolean))].sort();
    $("#chips").innerHTML = ['<button class="chip" data-course="" aria-pressed="' + (!course) + '">All classes</button>']
      .concat(courses.map((c) => '<button class="chip" data-course="' + esc(c) + '" aria-pressed="' + (c === course) + '"><i style="background:' + colorFor(c) + '"></i>' + esc(c) + '</button>')).join("");
    const q = query.toLowerCase();
    const list = visible.filter((it) => (!course || it.course === course) &&
      (!q || (it.title + " " + it.course + " " + (it.det?.description || "")).toLowerCase().includes(q))).sort(byDue);
    const dated = list.filter((i) => i.due), undated = list.filter((i) => !i.due);
    html = group("With a due date", dated, now) + group("No due date", undated, now);
    if (!html) html = empty("Nothing here", q || course ? "No assignments match that filter." : "Nothing assigned right now.");
  } else {
    const list = items.filter((it) => hidden.has(it.key)).sort(byDue);
    html = list.length ? group("Hidden", list, now) : empty("Nothing hidden", "Use the X on an assignment to tuck it away here.");
  }
  $("#list").innerHTML = html;

  const last = D.assigned?.scrapedAt;
  const stale = !last || Date.now() - Date.parse(last) > 3 * 36e5;
  $("#sync").innerHTML = '<span class="dot' + (stale ? ' stale' : '') + '"></span>' +
    (last ? "Synced " + ago(last) + (stale ? " &middot; Is Chrome open?" : "") : "Not synced yet. Click Sync now in the extension.");
}

// ---- detail drawer
let pushed = false;
function linkify(text) {
  return esc(text).replace(/https?:\\/\\/[^\\s<]+[^\\s<.,;:!?)\\]'"]/g, (u) => '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>');
}
function fileCard(a) {
  let host = ""; try { host = new URL(a.url).hostname.replace(/^www\\./, ""); } catch {}
  const k = KIND[a.kind] ? a.kind : "link";
  return '<a class="file" href="' + esc(a.url) + '" target="_blank" rel="noopener"><div class="ic ' + k + '">' + KIND[k] + '</div>' +
    '<div class="fn"><b>' + esc(a.name) + '</b><span>' + esc(a.sub || host) + '</span></div><span style="color:var(--text-3)">' + ICON.ext + '</span></a>';
}

function openDetail(id, push = true) {
  const it = items[id];
  if (!it) return closeDetail(false);
  const now = new Date(), det = it.det, b = bucket(it, now), w = whenParts(it, now);
  const dueLabel = it.due ? "Due " + fLong.format(new Date(it.due)) : (it.dueText || "No due date");
  const pills = ['<span class="pill ' + (b === "missing" ? "red" : b === "today" ? "amber" : "") + '">' + esc(dueLabel) + '</span>'];
  if (b === "missing") pills.push('<span class="pill red">' + esc(w.sub || "Missing") + '</span>');
  if (det?.teacher) pills.push('<span class="pill">' + esc(det.teacher) + '</span>');
  if (det?.points) pills.push('<span class="pill">' + esc(det.points) + '</span>');

  let body = '<h2>' + esc(it.title) + '</h2><div class="meta">' + pills.join("") + '</div>' +
    '<a class="primary" href="' + esc(it.link || "https://classroom.google.com/a/not-turned-in/all") + '" target="_blank" rel="noopener">Open in Classroom ' + ICON.ext + '</a>';

  if (det) {
    body += '<div class="sec"><h3>Instructions</h3>' + (det.description ? '<div class="desc">' + linkify(det.description) + '</div>' : '<div class="note">No instructions.</div>') + '</div>';
    if (det.attachments?.length) body += '<div class="sec"><h3>Attachments</h3><div class="files">' + det.attachments.map(fileCard).join("") + '</div></div>';
    if (det.work) {
      const st = det.work.status || (b === "missing" ? "Missing" : "Assigned");
      const tone = /missing/i.test(st) ? "red" : /turned in|done|graded|returned/i.test(st) ? "green" : "";
      body += '<div class="sec"><h3>Your work</h3><div class="work"><div class="wh"><b>Status</b><span class="pill ' + tone + '">' + esc(st) + '</span></div>' +
        (det.work.attachments?.length ? '<div class="files">' + det.work.attachments.map(fileCard).join("") + '</div>' : '<div class="note">Nothing attached yet. Add work and turn it in from Classroom.</div>') +
        '</div></div>';
    }
  } else {
    body += '<div class="sec"><div class="muted-box">Instructions and files for this assignment haven\\'t synced yet. They\\'ll show up after the next sync.</div></div>';
  }
  body += hidden.has(it.key)
    ? '<button class="hidebtn" data-restore="' + it.id + '">Restore to list</button>'
    : '<button class="hidebtn" data-hide="' + it.id + '">Hide this assignment</button>';

  $("#drawer").innerHTML = '<div class="dh"><div class="course"><i style="background:' + it.color + '"></i><span>' + esc(it.course || "Assignment") + '</span></div>' +
    '<button class="close" id="close" aria-label="Close">' + ICON.x + '</button></div><div class="db">' + body + '</div>';
  $("#drawer").classList.add("on"); $("#drawer").setAttribute("aria-hidden", "false"); $("#drawer").scrollTop = 0;
  $("#scrim").classList.add("on");
  document.body.style.overflow = "hidden";
  if (push && location.hash !== "#a" + id) { history.pushState(null, "", "#a" + id); pushed = true; }
}

function closeDetail(back = true) {
  $("#drawer").classList.remove("on"); $("#drawer").setAttribute("aria-hidden", "true");
  $("#scrim").classList.remove("on");
  document.body.style.overflow = "";
  if (back && pushed) { pushed = false; history.back(); }
  else if (back && location.hash) history.replaceState(null, "", location.pathname);
}

// ---- hide / restore
let toastTimer;
function toast(msg, undo) {
  const t = $("#toast");
  t.innerHTML = '<span>' + esc(msg) + '</span>' + (undo ? '<button id="undo">Undo</button>' : "");
  t.classList.add("on");
  if (undo) $("#undo").onclick = () => { undo(); t.classList.remove("on"); };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 4500);
}
async function setHidden(it, h) {
  h ? hidden.add(it.key) : hidden.delete(it.key);
  render();
  try {
    const r = await fetch("/api/hide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: it.link, hidden: h }) });
    if (!r.ok) throw 0;
  } catch { h ? hidden.delete(it.key) : hidden.add(it.key); render(); toast("Couldn't save that. Check your connection."); }
}

// ---- events
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-hide],[data-restore],[data-tab],[data-course],.row,#close,#scrim");
  if (!t) return;
  if (t.dataset.hide) {
    const it = items[t.dataset.hide];
    if (!it.link) return toast("This one can't be hidden.");
    if ($("#drawer").classList.contains("on")) closeDetail();
    setHidden(it, true); toast("Hidden", () => setHidden(it, false));
  } else if (t.dataset.restore) {
    const it = items[t.dataset.restore];
    if ($("#drawer").classList.contains("on")) closeDetail();
    setHidden(it, false); toast("Restored");
  } else if (t.dataset.tab) {
    tab = t.dataset.tab; try { localStorage.setItem("tab", tab); } catch {} render();
  } else if (t.dataset.course !== undefined) {
    course = t.dataset.course; render();
  } else if (t.classList.contains("row")) {
    openDetail(+t.dataset.id);
  } else {
    closeDetail();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#drawer").classList.contains("on")) closeDetail();
  if (e.key === "Enter" && e.target.classList?.contains("row")) openDetail(+e.target.dataset.id);
});
$("#q").addEventListener("input", (e) => { query = e.target.value; render(); });
window.addEventListener("popstate", () => {
  const m = location.hash.match(/^#a(\\d+)$/);
  m ? openDetail(+m[1], false) : closeDetail(false);
});

render();
const m0 = location.hash.match(/^#a(\\d+)$/);
if (m0) openDetail(+m0[1], false);
setInterval(render, 60000);
`;
