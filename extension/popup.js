const $ = (id) => document.getElementById(id);
const DEFAULT_URL = "https://gclass.helloimthesigma.workers.dev"; // keep in sync with background.js
const FIELDS = ["workerUrl", "accessKey", "email"];

async function load() {
  const s = await chrome.storage.sync.get(FIELDS);
  for (const f of FIELDS) $(f).value = s[f] || "";
  if (!$("workerUrl").value) $("workerUrl").value = DEFAULT_URL;
  $("open").href = $("workerUrl").value;
  const { lastStatus } = await chrome.storage.local.get("lastStatus");
  if (lastStatus) show(lastStatus.text + ` (${new Date(lastStatus.at).toLocaleTimeString()})`, lastStatus.ok);
  checkKey();
}

function show(text, ok) {
  $("status").textContent = text;
  $("status").className = ok ? "ok" : "bad";
}

// Ask the site whose key this is, so people know right away if they pasted it correctly.
async function checkKey() {
  const key = $("accessKey").value.trim();
  const who = $("who");
  if (!key) { who.textContent = "Paste your key below to get started."; who.className = "bad"; return false; }
  try {
    const res = await fetch($("workerUrl").value.replace(/\/+$/, "") + "/api/me", { headers: { Authorization: `Bearer ${key}` } });
    if (res.ok) { who.textContent = `Signed in as ${(await res.json()).name}`; who.className = ""; return true; }
    who.textContent = "That key wasn't accepted. Check it and click Save.";
  } catch {
    who.textContent = "Couldn't reach the site. Check your internet connection.";
  }
  who.className = "bad";
  return false;
}

async function save() {
  const vals = {};
  for (const f of FIELDS) vals[f] = $(f).value.trim();
  vals.workerUrl = (vals.workerUrl || DEFAULT_URL).replace(/\/+$/, "");
  if (!/^https:\/\//.test(vals.workerUrl)) vals.workerUrl = "https://" + vals.workerUrl.replace(/^http:\/\//, "");
  $("workerUrl").value = vals.workerUrl;
  await chrome.storage.sync.set(vals);
  $("open").href = vals.workerUrl;
  return checkKey();
}

$("save").onclick = async () => {
  if (await save()) show("Saved. Now click Sync now.", true);
};

$("sync").onclick = async () => {
  if (!(await save())) return show("Fix your key first.", false);
  show("Syncing… this can take a few minutes. You can close this popup.", true);
  const res = await chrome.runtime.sendMessage({ type: "syncNow" });
  show(res.text, res.ok);
};

load();
