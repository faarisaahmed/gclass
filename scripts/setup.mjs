#!/usr/bin/env node
// One-command setup: logs in to Cloudflare, creates storage, deploys the site, sets an access
// key, and writes extension/config.js so the Chrome extension is pre-filled.
// Works on Windows, macOS and Linux. Run it with:  npm run setup
// Safe to run again: it remembers your answers in .setup.json (never committed).

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const yes = process.argv.includes("--yes"); // accept saved/default answers without asking
const statePath = path.join(root, ".setup.json");

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const step = (n, s) => console.log(`\n${bold(`[${n}/6]`)} ${s}`);
const fail = (msg) => { console.error(`\n${red("Setup stopped:")} ${msg}\n`); process.exit(1); };

// Run a command. `capture` collects stdout (still shown unless quiet); `input` is piped to stdin.
function run(cmd, args, { capture = false, quiet = false, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: root,
      shell: isWin, // needed on Windows to run npm/npx/.cmd files
      stdio: [input !== undefined ? "pipe" : "inherit", capture ? "pipe" : "inherit", capture && quiet ? "pipe" : "inherit"],
    });
    let out = "";
    if (capture) {
      child.stdout.on("data", (d) => { out += d; if (!quiet) process.stdout.write(d); });
      child.stderr?.on("data", (d) => { out += d; });
    }
    if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
    child.on("error", (e) => resolve({ code: 1, out: String(e) }));
    child.on("close", (code) => resolve({ code, out }));
  });
}
const wrangler = (args, opts) => run("npx", ["--no-install", "wrangler", ...args], opts);

async function main() {
  console.log(bold("\nGoogle Classroom assignments site: setup\n"));

  const major = +process.versions.node.split(".")[0];
  if (major < 20) fail(`You have Node.js ${process.versions.node}. Install Node.js 20 or newer from https://nodejs.org and try again.`);

  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
  const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  // 1. dependencies
  step(1, "Installing dependencies");
  if (!fs.existsSync(path.join(root, "node_modules", "wrangler"))) {
    const r = await run("npm", ["install", "--no-fund", "--no-audit"]);
    if (r.code) fail("npm install failed. Check your internet connection and try again.");
  } else console.log("Already installed.");

  // 2. Cloudflare login
  step(2, "Signing in to Cloudflare");
  let who = await wrangler(["whoami"], { capture: true, quiet: true });
  if (/not authenticated|not logged in/i.test(who.out) || who.code) {
    console.log("A browser window will open. Sign in to Cloudflare (or create a free account) and click Allow.");
    const r = await wrangler(["login"]);
    if (r.code) fail("Cloudflare login didn't finish. Run `npm run setup` again.");
    who = await wrangler(["whoami"], { capture: true, quiet: true });
  }
  const acct = who.out.match(/associated with the email ([^\s.]+@[^\s]+?)\.?\s/);
  console.log(green(`Signed in${acct ? ` as ${acct[1]}` : ""}.`));

  // 3. questions
  step(3, "A few questions (press Enter to accept the default in brackets)");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => {
    if (yes) return def;
    const a = (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim();
    return a || def || "";
  };
  let name;
  for (;;) {
    name = (await ask("Site name (becomes https://<name>.<your-subdomain>.workers.dev)", state.name || "gclass")).toLowerCase();
    if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) break;
    console.log(red("Use only lowercase letters, numbers and dashes."));
    if (yes) fail("Invalid site name in .setup.json.");
  }
  const email = await ask("Your school Google email (optional, helps if Chrome has several Google accounts)", state.email || "");
  const timezone = await ask("Your timezone", state.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York");
  rl.close();
  Object.assign(state, { name, email, timezone });
  save();

  // 4. storage (KV namespace)
  step(4, "Creating storage for your assignments");
  if (!state.kvId) {
    const title = `${name}-data`;
    const r = await wrangler(["kv", "namespace", "create", title], { capture: true, quiet: true });
    let id = (r.out.match(/\b([0-9a-f]{32})\b/) || [])[1];
    if (!id) {
      // Maybe it already exists from an earlier run.
      const list = await wrangler(["kv", "namespace", "list"], { capture: true, quiet: true });
      try { id = JSON.parse(list.out.slice(list.out.indexOf("["))).find((n) => n.title === title)?.id; } catch {}
    }
    if (!id) fail(`Couldn't create storage:\n${r.out}`);
    state.kvId = id;
    save();
  }
  console.log(green("Storage ready."));

  const toml = fs.readFileSync(path.join(root, "wrangler.example.toml"), "utf8")
    .replace("__NAME__", name).replace("__KV_ID__", state.kvId).replace("__TIMEZONE__", timezone);
  fs.writeFileSync(path.join(root, "wrangler.toml"), toml);

  // 5. deploy + access key
  step(5, "Publishing your site");
  const dep = await wrangler(["deploy"], { capture: true });
  if (dep.code) {
    if (/subdomain/i.test(dep.out)) {
      fail("Your Cloudflare account doesn't have a workers.dev subdomain yet.\n" +
        "Open https://dash.cloudflare.com, click \"Workers & Pages\" in the sidebar, pick a subdomain when asked,\n" +
        "then run `npm run setup` again.");
    }
    fail("Publishing failed (see the messages above). Fix the problem and run `npm run setup` again.");
  }
  const url = (dep.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i) || [])[0];
  if (!url) fail("Published, but couldn't find the site URL in the output above.");
  state.url = url;

  state.accessKey ||= crypto.randomBytes(15).toString("base64url");
  save();
  const sec = await wrangler(["secret", "put", "ACCESS_KEY"], { capture: true, quiet: true, input: state.accessKey });
  if (sec.code) fail(`Couldn't save the access key:\n${sec.out}`);
  console.log(green("Site published and access key saved."));

  // 6. pre-fill the extension
  step(6, "Preparing the Chrome extension");
  const config = { workerUrl: url, accessKey: state.accessKey, email };
  fs.writeFileSync(path.join(root, "extension", "config.js"),
    `// Written by npm run setup. Contains your access key, so don't share or commit this file.\nself.GCLASS_CONFIG = ${JSON.stringify(config, null, 2)};\n`);
  fs.writeFileSync(path.join(root, "MY-SITE.txt"),
    `Your assignments site\n\nSite URL:   ${url}\nAccess key: ${state.accessKey}\n\nKeep the access key private. Anyone with it can see your assignments.\n`);
  console.log(green("Done."));

  console.log(`
${bold("Your site:")}   ${url}
${bold("Access key:")}  ${state.accessKey}
(Both are also saved in MY-SITE.txt in this folder.)

${bold("Next:")} load the extension in Chrome (README, step 4):
  1. Open chrome://extensions and turn on Developer mode (top right).
  2. Click "Load unpacked" and choose this folder:
     ${path.join(root, "extension")}
     (Already loaded? Click its reload arrow instead.)
  3. Click the extension's icon and press "Sync now".
`);
}

main().catch((e) => fail(e.stack || String(e)));
