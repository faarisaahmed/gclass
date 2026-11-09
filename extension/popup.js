const $ = (id) => document.getElementById(id);
const FIELDS = ["workerUrl", "accessKey", "email"];

async function load() {
  const s = await chrome.storage.sync.get(FIELDS);
  for (const f of FIELDS) $(f).value = s[f] || "";
  $("open").href = s.workerUrl || "#";
  const { lastStatus } = await chrome.storage.local.get("lastStatus");
  if (lastStatus) show(lastStatus.text + ` (${new Date(lastStatus.at).toLocaleTimeString()})`, lastStatus.ok);
}

function show(text, ok) {
  $("status").textContent = text;
  $("status").className = ok ? "ok" : "bad";
}

async function save() {
  const vals = {};
  for (const f of FIELDS) vals[f] = $(f).value.trim();
  vals.workerUrl = vals.workerUrl.replace(/\/+$/, "");
  if (vals.workerUrl && !/^https:\/\//.test(vals.workerUrl)) vals.workerUrl = "https://" + vals.workerUrl;
  $("workerUrl").value = vals.workerUrl;
  await chrome.storage.sync.set(vals);
  $("open").href = vals.workerUrl || "#";
}

$("save").onclick = async () => {
  await save();
  show("Saved.", true);
};

$("sync").onclick = async () => {
  await save();
  show("Syncing… this can take a few minutes. You can close this popup.", true);
  const res = await chrome.runtime.sendMessage({ type: "syncNow" });
  show(res.text, res.ok);
};

load();
