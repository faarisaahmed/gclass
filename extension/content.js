// Runs on classroom.google.com. background.js asks it to scrape either a To-do list page
// or a single assignment's detail page, and it replies with what it found.

(() => {
  // Links to classwork: /c/<courseId>/a/<workId>/details  (a = assignment, mc/sa = questions,
  // m = material, p = post). Optional /u/N/ prefix.
  const WORK_LINK = /\/c\/[^/]+\/(a|mc|sa|m|p)\/[^/]+/;
  const NOISE = /^(assigned|missing|turned in|done late|done|graded|returned|no due date|posted\b|edited\b|\d+\s+(points?|pts)|more_vert|open|view)/i;
  const STATUS_WORDS = /^(assigned|missing|turned in late|turned in|handed in late|handed in|done late|done|graded|returned|not turned in|marked as done|done late)$/i;

  let currentStatus = "assigned";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const main = () => document.querySelector("[role=main]") || document.body;
  const clean = (s) => (s || "").replace(/​/g, "").trim();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== "scrape") return;
    (async () => {
      try {
        if (msg.kind === "list") {
          currentStatus = msg.status;
          collected.clear();
          if (msg.navigate && !location.pathname.endsWith(msg.navigate)) {
            // Switch tabs inside Classroom (like clicking "Missing") instead of a full page load.
            const link = [...document.querySelectorAll("a[href]")].find((a) => {
              try { return new URL(a.href).pathname.endsWith(msg.navigate); } catch { return false; }
            });
            if (!link) throw new Error("Couldn't find the " + msg.status + " tab in Classroom.");
            link.click();
            for (let i = 0; i < 40 && !location.pathname.endsWith(msg.navigate); i++) await sleep(250);
            await sleep(1000);
          }
          await waitForStable(() => workLinks() + document.body.innerText.length, true);
          sendResponse({ ok: true, items: scrapeList(msg.status), loading: isLoading(), hidden: document.hidden, snapshot: msg.debug ? snapshot() : null });
        } else {
          await waitForStable(() => document.body.innerText.length, false);
          sendResponse({ ok: true, detail: scrapeDetail(), loading: isLoading(), hidden: document.hidden, snapshot: msg.debug ? snapshot() : null });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  });

  // Classroom collapses some To-do sections ("No due date", "Next week", "Later", "Earlier") and
  // only shows the first few items until "View all" is clicked. Click only those controls, once each.
  const SECTION = /^(no due date|this week|next week|later|earlier)\b/i;
  function expandSections() {
    for (const el of document.querySelectorAll('button[aria-expanded="false"]')) {
      if (el.dataset.gcsClicked) continue;
      if (!SECTION.test(el.getAttribute("aria-label") || "")) continue;
      el.dataset.gcsClicked = "1";
      el.click();
    }
    for (const el of document.querySelectorAll("button")) {
      if (el.dataset.gcsClicked || !/^view all$/i.test(clean(el.innerText))) continue;
      if (el.closest("header, nav, [role=dialog], [role=menu]")) continue;
      el.dataset.gcsClicked = "1";
      el.click();
    }
  }

  // Classroom shows a status element labelled "Page is loading…" until its data arrives.
  const isLoading = () =>
    [...document.querySelectorAll('[role=status][aria-label], [role=progressbar][aria-label]')]
      .some((el) => /loading/i.test(el.getAttribute("aria-label")) && el.offsetParent !== null);

  const workLinks = () => [...document.querySelectorAll("a[href]")].filter((a) => {
    try { return WORK_LINK.test(new URL(a.href).pathname); } catch { return false; }
  }).length;

  // Wait until Classroom finished loading and the content stopped changing.
  async function waitForStable(measure, isList, maxMs = 45000) {
    let last = -1, stableFor = 0;
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (isList) {
        collectList(currentStatus);
        expandSections();
        window.scrollTo(0, document.body.scrollHeight); // trigger lazy loading
      }
      const n = measure();
      if (n === last) stableFor += 500; else { stableFor = 0; last = n; }
      const ready = !isLoading() || (isList && workLinks() > 0);
      if (ready && stableFor >= 2500 && Date.now() - start > 3000) break;
      await sleep(500);
    }
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------ list page

  function parseDue(text, status) {
    if (!text) return null;
    let s = text.replace(/^due[:\s]*/i, "").trim();
    let h = 23, m = 59;
    const t = s.match(/(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/i);
    if (t) {
      h = (+t[1] % 12) + (t[3].toLowerCase() === "p" ? 12 : 0);
      m = +t[2];
      s = s.replace(t[0], "");
    }
    s = s.replace(/,/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
    const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

    if (/^today/.test(s) || (t && !s)) return d.toISOString(); // a bare time means today
    if (/^tomorrow/.test(s)) { d.setDate(d.getDate() + 1); return d.toISOString(); }
    if (/^yesterday/.test(s)) { d.setDate(d.getDate() - 1); return d.toISOString(); }

    const wd = days.findIndex((x) => s.startsWith(x) || s.startsWith(x.slice(0, 3) + " ") || s === x.slice(0, 3));
    if (wd >= 0 && !/\d/.test(s.replace(/^\w+/, ""))) {
      let diff = (wd - d.getDay() + 7) % 7;
      if (status === "missing" && diff > 0) diff -= 7; // a missing item's weekday is in the past
      d.setDate(d.getDate() + diff);
      return d.toISOString();
    }

    const md = s.match(/(?:^|\s)([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:\s+(\d{4}))?/);
    if (md && months.includes(md[1])) {
      const year = md[3] ? +md[3] : now.getFullYear();
      const out = new Date(year, months.indexOf(md[1]), +md[2], h, m);
      if (!md[3]) {
        if (status !== "missing" && out < now - 60 * 86400e3) out.setFullYear(year + 1);
        if (status === "missing" && out > now.getTime() + 86400e3) out.setFullYear(year - 1);
      }
      return out.toISOString();
    }
    return null;
  }

  function linesOf(el) {
    return [...new Set(el.innerText.split("\n").map(clean).filter(Boolean))];
  }

  // Text without Material icon ligatures like "assignment" or "keyboard_arrow_up".
  const ICONS = ".google-symbols, .material-icons, .material-symbols-outlined";
  function linesOfNoIcons(el) {
    const icons = new Set([...el.querySelectorAll(ICONS)].map((i) => clean(i.textContent)));
    return [...new Set(el.innerText.split("\n").map(clean).filter((l) => l && !icons.has(l)))];
  }
  function textOf(el) {
    return el ? linesOfNoIcons(el).join(" ") : "";
  }

  const collected = new Map();
  function collectList(status) {
    for (const a of document.querySelectorAll("a[href]")) {
      let path;
      try { path = new URL(a.href).pathname; } catch { continue; }
      if (!WORK_LINK.test(path)) continue;
      const href = a.href.split("?")[0];
      const row = a.closest("li") || a;
      const lines = linesOfNoIcons(row);
      if (!lines.length) continue;

      // Classroom's To-do rows: <p class=oDLUVd> title, <p class=tWeh6> class, <p class=iiWxqc> "Posted ...",
      // <p class=oPfDcb> due ("Tomorrow, 11:59 PM"). Fall back to line order if those classes change.
      const title = textOf(row.querySelector("p.oDLUVd")) || lines.find((l) => !NOISE.test(l) && !/^due\b/i.test(l)) || lines[0];
      const course = textOf([...row.querySelectorAll("p.tWeh6")].find((p) => !/^posted\b/i.test(textOf(p)))) ||
        lines.filter((l) => l !== title && !NOISE.test(l) && !/^posted\b/i.test(l))[0] || "";
      const dueEl = row.querySelector("p.oPfDcb");
      const dueLine = textOf(dueEl) ||
        lines.find((l) => /^due\b/i.test(l)) ||
        lines.find((l) => /\d{1,2}:\d{2}\s*[ap]\.?m/i.test(l) || /^(today|tomorrow|yesterday)\b/i.test(l)) || "";
      const posted = lines.find((l) => /^posted\b/i.test(l)) || "";

      const postedAt = posted ? parseDue(posted.replace(/^posted\s*/i, ""), "missing") : null; // "missing" = parse as a past date
      collected.set(href, { title, course, dueText: dueLine, due: parseDue(dueLine, status), posted, postedAt, link: href, lines });
    }
  }
  function scrapeList(status) {
    collectList(status);
    return [...collected.values()];
  }

  // ------------------------------------------------------------ detail page

  function kindOf(url) {
    const u = url.toLowerCase();
    if (u.includes("docs.google.com/document")) return "doc";
    if (u.includes("docs.google.com/spreadsheets")) return "sheet";
    if (u.includes("docs.google.com/presentation")) return "slides";
    if (u.includes("docs.google.com/forms") || u.includes("forms.gle")) return "form";
    if (u.includes("drive.google.com")) return "drive";
    if (u.includes("youtube.com") || u.includes("youtu.be")) return "video";
    if (/\.pdf(\?|$)/.test(u)) return "pdf";
    return "link";
  }

  function realUrl(a) {
    // Google sometimes wraps outbound links: https://www.google.com/url?q=<real>
    try {
      const u = new URL(a.href);
      if (/google\.com$/.test(u.hostname) && u.pathname === "/url") return u.searchParams.get("q") || a.href;
      return a.href;
    } catch { return a.href; }
  }

  // The "Your work" card: <h2 class=aAxDBb>Your work</h2>, inside the side panel.
  function findYourWork() {
    const h = [...document.querySelectorAll("h2, h3")].find((el) => /^your work$/i.test(clean(el.textContent)));
    if (!h) return null;
    let el = h;
    for (let i = 0; i < 8 && el.parentElement; i++) {
      el = el.parentElement;
      if (/(turn in|hand in|mark as done|unsubmit|add or create|no work attached)/i.test(el.innerText)) return el;
    }
    return h.parentElement;
  }

  function findCommentsBox() {
    const el = [...document.querySelectorAll("span,div,h2,h3")].find(
      (e) => e.childElementCount === 0 && /^(class comments|private comments)$/i.test(clean(e.textContent)),
    );
    return el ? el.closest("section") || el.parentElement?.parentElement : null;
  }

  // Readable text from rich content: keeps line breaks and turns list items into bullets.
  function richText(root) {
    let out = "";
    const BLOCK = /^(DIV|P|UL|OL|LI|H[1-6]|BLOCKQUOTE|TABLE|TR)$/;
    const walk = (n) => {
      if (n.nodeType === 3) { out += n.textContent; return; }
      if (n.nodeType !== 1) return;
      if (n.matches(ICONS)) return;
      if (n.tagName === "BR") { out += "\n"; return; }
      const block = BLOCK.test(n.tagName);
      if (block && !out.endsWith("\n")) out += "\n";
      if (n.tagName === "LI") out += (n.parentElement?.tagName === "OL" ? `${[...n.parentElement.children].indexOf(n) + 1}. ` : "\u2022 ");
      for (const c of n.childNodes) walk(c);
      if (block && !out.endsWith("\n")) out += "\n";
    };
    walk(root);
    return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function attachmentCards(root, skip) {
    const out = new Map();
    for (const a of root.querySelectorAll("a[href]")) {
      if (skip && skip(a)) continue;
      const url = realUrl(a);
      if (!/^https?:/.test(url) || /classroom\.google\.com|accounts\.google\.com|support\.google\.com|policies\.google/.test(url)) continue;
      const label = a.getAttribute("aria-label") || "";
      // Classroom cards: aria-label "Attachment: Google Docs: <name>", <div class=mvRF3b> name, <div class=kRYv9b> type
      const name = textOf(a.querySelector(".mvRF3b")) || label.replace(/^attachment:\s*[^:]+:\s*/i, "") || linesOfNoIcons(a)[0] || url;
      const sub = textOf(a.querySelector(".kRYv9b")) || (label.match(/^attachment:\s*([^:]+):/i) || [])[1] || "";
      if (!out.has(url)) out.set(url, { name: name.slice(0, 200), url, kind: kindOf(url), sub: sub.slice(0, 120) });
    }
    return [...out.values()];
  }

  function scrapeDetail() {
    const work = findYourWork();
    const comments = findCommentsBox();
    const outside = (n) => (work && work.contains(n)) || (comments && comments.contains(n));

    const h1 = document.querySelector("h1");
    const title = textOf(h1);
    const metaRow = h1?.closest("div")?.parentElement?.querySelector(".rec5Nb");
    const meta = metaRow ? linesOfNoIcons(metaRow).filter((l) => l !== "\u2022") : [];
    const allLines = linesOfNoIcons(document.querySelector("[role=main]") || document.body);
    const dueText = textOf(document.querySelector(".W4hhKd")) || allLines.find((l) => /^due\b/i.test(l)) || "";
    const points = allLines.find((l) => /^\d+(\.\d+)?\s+points?$/i.test(l)) || "";

    // Instructions live in <div class=nGi02b>; fall back to pre-wrap text blocks.
    let descEls = [...document.querySelectorAll(".nGi02b")].filter((el) => !outside(el));
    if (!descEls.length) {
      descEls = [];
      for (const el of document.querySelectorAll("span, div")) {
        if (outside(el) || (h1 && h1.contains(el)) || descEls.some((b) => b.contains(el))) continue;
        if (getComputedStyle(el).whiteSpace.startsWith("pre") && el.innerText.trim().length > 20) descEls.push(el);
      }
    }
    const description = descEls.map(richText).filter(Boolean).join("\n\n").slice(0, 8000);

    let workInfo = null;
    if (work) {
      const leaves = [...work.querySelectorAll("span, div, p")].filter((e) => e.childElementCount === 0).map((e) => clean(e.textContent));
      workInfo = {
        status: leaves.find((l) => STATUS_WORDS.test(l)) || "",
        attachments: attachmentCards(work),
      };
    }

    return {
      title,
      teacher: meta[0] || "",
      dueText,
      points,
      description,
      attachments: attachmentCards(document.body, (n) => outside(n) || !!n.closest("nav, header, [role=menu]")),
      work: workInfo,
    };
  }

  // ------------------------------------------------------------ debug snapshot
  // A compact outline of the page (tags, roles, labels, links, short text) so the scraper
  // can be tuned to Classroom's real layout. Uploaded only to your own Worker.

  function snapshot(limit = 400000) {
    const out = [];
    let size = 0;
    const walk = (el, depth) => {
      if (size > limit) return;
      const tag = el.tagName.toLowerCase();
      if (["script", "style", "svg", "path", "noscript", "link", "meta"].includes(tag)) return;
      const attrs = [];
      for (const n of ["role", "aria-label", "aria-expanded", "jsname", "data-item-id"]) {
        const v = el.getAttribute(n);
        if (v) attrs.push(`${n}="${v.slice(0, 60)}"`);
      }
      if (el.className && typeof el.className === "string") attrs.push(`.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`);
      if (tag === "a") attrs.push(`href="${(el.getAttribute("href") || "").slice(0, 150)}"`);
      const ws = getComputedStyle(el).whiteSpace;
      if (ws.startsWith("pre")) attrs.push("ws=pre");
      const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").slice(0, 150);
      const line = `${"  ".repeat(Math.min(depth, 40))}<${tag} ${attrs.join(" ")}>${text ? " " + JSON.stringify(text) : ""}`;
      out.push(line);
      size += line.length;
      for (const c of el.children) walk(c, depth + 1);
    };
    walk(document.body, 0);
    return `URL: ${location.href}\nTITLE: ${document.title}\nHIDDEN: ${document.hidden}\nLOADING: ${isLoading()}\n\n` + out.join("\n");
  }
})();
