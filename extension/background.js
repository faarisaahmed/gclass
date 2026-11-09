// Every 30 minutes: open Classroom in one pinned background tab, scrape the To-do list,
// then visit assignments to grab their directions and files, upload it all, close the tab.

// config.js is written by `npm run setup` (it holds your Worker URL, key and email) and is never
// committed to git. Without it, you fill those in from the extension popup instead.
// The shared site everyone uses. People hosting their own copy can change it in the popup.
const DEFAULT_URL = "https://gclass.helloimthesigma.workers.dev";
self.GCLASS_CONFIG = {};
try { importScripts("config.js"); } catch {}
const LISTS = [
  { status: "assigned", path: "/a/not-turned-in/all" },
];
const WEEK_MS = 7 * 86400e3;
// Same rule as the site: skip past-due work and no-due-date work posted over a week ago.
function relevant(i, now) {
  if (i.due) return Date.parse(i.due) >= now;
  return !i.postedAt || Date.parse(i.postedAt) >= now - WEEK_MS;
}
const INTERVAL_MIN = 30;
const DETAIL_MAX_PER_SYNC = 15;            // keep each sync reasonably quick
const DETAIL_REFRESH_MS = 12 * 3600e3;     // re-check an assignment's details twice a day

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create("sync", { periodInMinutes: INTERVAL_MIN }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create("sync", { periodInMinutes: INTERVAL_MIN }));
chrome.runtime.onInstalled.addListener(async () => {
  await closeLeftovers();
  // Copy config.js (from setup) into the popup's settings whenever the extension is installed or reloaded.
  const c = self.GCLASS_CONFIG || {};
  const vals = {};
  if (c.workerUrl) vals.workerUrl = c.workerUrl;
  if (c.accessKey) vals.accessKey = c.accessKey;
  if (c.email) vals.email = c.email;
  if (Object.keys(vals).length) await chrome.storage.sync.set(vals);
});
chrome.alarms.onAlarm.addListener((a) => a.name === "sync" && syncAll());

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "syncNow") {
    syncAll(true).then(sendResponse);
    return true;
  }
});

async function settings() {
  const s = await chrome.storage.sync.get(["workerUrl", "accessKey", "email"]);
  const c = self.GCLASS_CONFIG || {};
  const workerUrl = s.workerUrl || c.workerUrl || DEFAULT_URL;
  return { workerUrl: workerUrl.replace(/\/+$/, ""), accessKey: s.accessKey || c.accessKey || "", email: s.email || c.email || "" };
}

async function setStatus(text, ok) {
  await chrome.storage.local.set({ lastStatus: { text, ok, at: new Date().toISOString() } });
}

async function post(path, body) {
  const { workerUrl, accessKey } = await settings();
  if (!accessKey) throw new Error("Paste your key in this popup and click Save first.");
  const res = await fetch(`${workerUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessKey}` },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Error("The site didn't accept your key. Check it in this popup.");
  if (!res.ok) throw new Error(`The site said ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function withAccount(url) {
  const u = new URL(url, "https://classroom.google.com");
  // If you're signed in to several Google accounts, this picks the school one.
  const { email } = await settings();
  if (email) u.searchParams.set("authuser", email);
  return u.toString();
}

function waitForLoad(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(t); resolve(); };
    const listener = (id, info) => id === tabId && info.status === "complete" && done();
    const t = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function scrapeIn(tabId, url, request) {
  if (url) {
    await chrome.tabs.update(tabId, { url: await withAccount(url) });
    await waitForLoad(tabId);
  }
  // The content script may need a moment to attach; retry until it answers.
  for (let i = 0; i < 20; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "scrape", ...request });
      if (res) return res;
    } catch {}
    await new Promise((r) => setTimeout(r, 750));
  }
  const tab = await chrome.tabs.get(tabId);
  if (/accounts\.google\.com/.test(tab.url || "")) throw new Error("Not signed in to Google Classroom in this Chrome profile.");
  throw new Error("Classroom page didn't respond. Try again.");
}

// Chrome may not fully render pages in hidden background tabs. If that happens, use a small
// unfocused window instead and remember that choice for future syncs.
// Remember what we opened so leftovers (e.g. from reloading the extension mid-sync) get closed.
async function track(kind, id, add) {
  const { opened = [] } = await chrome.storage.local.get("opened");
  const next = opened.filter((o) => !(o.kind === kind && o.id === id));
  if (add) next.push({ kind, id });
  await chrome.storage.local.set({ opened: next });
}
async function closeLeftovers() {
  const { opened = [] } = await chrome.storage.local.get("opened");
  for (const o of opened) {
    if (o.kind === "window") await chrome.windows.remove(o.id).catch(() => {});
    else await chrome.tabs.remove(o.id).catch(() => {});
  }
  await chrome.storage.local.set({ opened: [] });
}

async function openScraper(mode) {
  if (mode === "window") {
    const win = await chrome.windows.create({ url: "about:blank", focused: false, type: "popup", width: 480, height: 640, left: 0, top: 0 });
    await track("window", win.id, true);
    return { tabId: win.tabs[0].id, close: () => chrome.windows.remove(win.id).catch(() => {}).then(() => track("window", win.id, false)) };
  }
  const tab = await chrome.tabs.create({ url: "about:blank", active: false, pinned: true });
  await track("tab", tab.id, true);
  return { tabId: tab.id, close: () => chrome.tabs.remove(tab.id).catch(() => {}).then(() => track("tab", tab.id, false)) };
}

let running = null;
function syncAll(manual = false) {
  if (running) return running;
  running = (async () => {
    let scraper;
    try {
      await closeLeftovers();
      let { mode2: mode = "tab" } = await chrome.storage.local.get("mode2");
      scraper = await openScraper(mode);
      const tab = { id: scraper.tabId };
      const counts = [];
      const allItems = [];

      for (const [idx, l] of LISTS.entries()) {
        // First list: load the page. Later lists: switch tabs inside the already-loaded Classroom page.
        const req = { kind: "list", status: l.status, debug: manual, navigate: idx ? l.path : null };
        let res = await scrapeIn(tab.id, idx ? null : l.path, req);
        if (res.ok && res.loading && !res.items.length && idx) {
          res = await scrapeIn(tab.id, l.path, { ...req, navigate: null }); // fall back to a full load
        }
        if (res.ok && res.loading && !res.items.length && mode === "tab") {
          scraper.close();
          mode = "window";
          await chrome.storage.local.set({ mode2: mode });
          scraper = await openScraper(mode);
          tab.id = scraper.tabId;
          res = await scrapeIn(tab.id, l.path, { ...req, navigate: null });
        }
        if (!res.ok) throw new Error(res.error);
        if (res.loading && !res.items.length) { counts.push(`${l.status} didn't load (kept last copy)`); continue; }
        await post("/api/ingest", { status: l.status, items: res.items });
        if (res.snapshot) await post("/api/debug", { name: `list-${l.status}`, text: res.snapshot });
        counts.push(`${res.items.length} ${l.status}`);
        allItems.push(...res.items);
      }

      // Details: new assignments first, then ones not checked in a while.
      const { fetched2: fetched = {} } = await chrome.storage.local.get("fetched2");
      const now = Date.now();
      const todo = allItems
        .filter((i) => i.link && relevant(i, now) && (!fetched[i.link] || now - fetched[i.link] > DETAIL_REFRESH_MS))
        .sort((a, b) => (fetched[a.link] || 0) - (fetched[b.link] || 0) || (a.due || "9").localeCompare(b.due || "9"))
        .slice(0, DETAIL_MAX_PER_SYNC);

      const details = [];
      for (const [n, item] of todo.entries()) {
        try {
          const res = await scrapeIn(tab.id, item.link, { kind: "detail", debug: manual && n === 0 });
          if (!res.ok) continue;
          details.push({ link: item.link, ...res.detail });
          fetched[item.link] = now;
          if (res.snapshot) await post("/api/debug", { name: "detail", text: res.snapshot });
        } catch (e) {
          console.warn("detail failed", item.link, e);
        }
      }
      if (details.length) await post("/api/details", { items: details });
      await chrome.storage.local.set({ fetched2: fetched });

      const text = `Synced ${counts.join(", ")}` + (details.length ? `, ${details.length} details` : "");
      await setStatus(text, true);
      return { ok: true, text };
    } catch (e) {
      await setStatus(e.message, false);
      return { ok: false, text: e.message };
    } finally {
      if (scraper) scraper.close();
      running = null;
    }
  })();
  return running;
}
