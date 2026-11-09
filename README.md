# gclass

**See your upcoming Google Classroom assignments on a private website.** Check it from your phone, another
computer, anywhere.

![The assignments site, showing upcoming work grouped by due date and an assignment's instructions, attachments and status](docs/screenshot.png)
<sub>(Screenshot uses made-up sample assignments.)</sub>

- **Upcoming:** what's due today, tomorrow, this week and later
- **All:** everything, including assignments with no due date, with search and a class filter
- **Click an assignment:** see the instructions, attached files, your work's status, and an *Open in Classroom* button
- **Hide** anything that isn't real work (like "Test tomorrow, here's a study guide!") with the X button
- Past-due work and no-due-date posts older than a week are left out automatically
- Works in light and dark mode, on desktop and phone

**Getting set up takes about 5 minutes.** You need a key from the person who runs the site, and a computer
with Chrome. You **don't** need to install anything else or make any accounts.

---

## How it works

```
 Your computer                                  The site                          Any device
┌──────────────────────────────┐   sends your  ┌──────────────────────────┐  view ┌───────────────┐
│ Chrome, signed in to         │  assignments  │ gclass.helloimthesigma   │ ────▶ │ Phone, laptop │
│ Classroom + this extension   │ ────────────▶ │       .workers.dev       │       │ (enter key)   │
└──────────────────────────────┘ every 30 min  └──────────────────────────┘       └───────────────┘
```

1. A **Chrome extension** on your computer reads your Classroom **To-do** page using the Google login you
   already have in Chrome. Your Google password is never typed into, stored by, or sent to anything.
2. Every 30 minutes, while Chrome is open, it sends your assignment list to the site, labelled with **your key**.
3. You open the site on any device and enter your key to see **your** assignments. Everyone has their own key
   and only sees their own work.

---

## What you need

| | |
|---|---|
| **Your key** | Ask the person who runs the site. They'll send you a message with your key. |
| **A computer** | Windows, Mac, or Linux. It's where the extension runs, so you'll want Chrome open on it sometimes. |
| **Google Chrome** | Microsoft Edge or Brave also work. **Firefox and Safari won't work.** |

> **School-issued Chromebooks usually won't work.** Schools normally block installing your own extensions.
> Use a personal computer.

---

## Step 1: Download the extension

1. On this GitHub page, click the green **Code** button near the top, then **Download ZIP**.
2. Unzip it:
   - **Windows:** open your Downloads folder, right-click `gclass-main.zip`, choose **Extract All…**, then **Extract**.
   - **Mac:** open your Downloads folder and double-click `gclass-main.zip`.
   - **Linux:** right-click the ZIP and choose **Extract Here**, or run `unzip gclass-main.zip`.
3. **Move the unzipped `gclass-main` folder somewhere it can stay**, like your Documents folder. Chrome loads the
   extension from this folder every time it starts, so don't delete it or leave it in Downloads where you might
   clean it up.

---

## Step 2: Add it to Chrome

1. Open Chrome and go to **`chrome://extensions`** (type it in the address bar and press Enter).
   - Edge: `edge://extensions`. Brave: `brave://extensions`.
2. Turn on **Developer mode**. It's a switch in the top-right corner (in Edge, on the left side).
3. Click **Load unpacked**.
4. Open the `gclass-main` folder, select the **`extension`** folder inside it, and click **Select** (or **Open**
   on Mac).
5. **Classroom To-do Sync** now shows up in your extensions. Click the **puzzle-piece icon** in Chrome's toolbar,
   then click the **pin** next to *Classroom To-do Sync* so its icon is always visible.

> Chrome may show a banner about "developer mode extensions". That's normal for extensions you add this way.
> You can close it.

---

## Step 3: Paste your key and sync

1. In the **same Chrome**, go to **https://classroom.google.com** and make sure you're signed in to your
   **school** account.
2. Click the **Classroom To-do Sync** icon in the toolbar.
3. Paste your key into **Your key** and click **Save**. It should say **"Signed in as *your name*"**.
   If it says the key wasn't accepted, check you copied all of it, with no extra spaces.
4. Is this Chrome signed in to more than one Google account (for example, personal and school)? Then also type your
   school email into **School Google email** and click **Save**.
5. Click **Sync now** and wait 1 to 3 minutes. A pinned Classroom tab appears and disappears on its own while it
   reads your assignments. Leave it alone. You can close the popup.
6. When the popup says **"Synced …"**, you're done.

---

## Step 4: Open your assignments

Go to **https://gclass.helloimthesigma.workers.dev** on any device and enter your key. It remembers you for 90 days.

**Add it to your phone's home screen** so it opens like an app:
- **iPhone (Safari):** tap the **Share** button, then **Add to Home Screen**.
- **Android (Chrome):** tap the **⋮** menu, then **Add to Home screen**.

---

## Everyday use

- **Keep Chrome open** on your computer, with any window (it doesn't need to be on Classroom). The extension
  syncs every 30 minutes. If Chrome is closed, the site keeps showing your last list and its
  "Synced … ago" dot turns yellow.
- **Want it updated right now?** Click the extension icon, then **Sync now**.
- **Hide** something with the **X** on its row. Find it again in the **Hidden** tab and click **Restore**.
- Click any assignment to see its instructions and files, or jump to it in Classroom.

## Getting a newer version

1. Download the ZIP again (Step 1) and unzip it.
2. Replace the files in your existing `gclass-main` folder with the new ones. Keep the folder in the **same place**.
3. Go to `chrome://extensions` and click the **reload arrow** on *Classroom To-do Sync*.

If you put the new version in a different folder instead, remove the old extension, load the new one
(Step 2), and paste your key again.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "That key wasn't accepted" | Re-copy the key from the message you were sent, with no spaces before or after. Still not working? Ask for a new key. |
| "Not signed in to Google Classroom in this Chrome profile" | Sign in at classroom.google.com **in the same Chrome window/profile** where you added the extension. |
| It synced the wrong Google account | Type your school email into **School Google email** in the popup, click **Save**, then **Sync now**. |
| "Load unpacked" isn't there | Turn on **Developer mode** first (Step 2). If you can't, your browser is managed by a school or work; use a personal computer. |
| "Manifest file is missing or unreadable" | You picked the wrong folder. Choose the **`extension`** folder *inside* `gclass-main`. |
| The extension disappeared or shows an error after a while | You probably moved or deleted the `gclass-main` folder. Put it back, or load it again (Step 2). |
| Site says "Synced 5 hr ago" and isn't updating | Chrome on your computer was closed or asleep. Open it and click **Sync now**. |
| An assignment says its instructions "haven't synced yet" | Wait for the next sync, or click **Sync now**. |
| Titles, dates or classes look wrong | Google may have changed Classroom's layout. Tell the person who runs the site. |
| Lost your key | Ask the person who runs the site for a new one. The old one stops working. |

---

## Privacy

- **Your Google password is never used.** The extension reads Classroom pages in your own browser, the same way
  you see them. It can only *read* Classroom; it can't turn in or change anything.
- On the site, **each person only sees their own assignments.** Your key is your password, so don't share it.
- Your assignment list (titles, due dates, instructions and attachment links) is stored on the site's
  Cloudflare account, which belongs to the person who runs it. Their admin page only shows names and when each
  person last synced, but as the account owner they could technically look at the stored data. Only use a site run
  by someone you trust.
- The extension can only access `classroom.google.com` and `*.workers.dev`.
- This is an unofficial personal project and isn't made by or affiliated with Google.

---

## For the site owner

**Adding people:** open the site, log in with your owner key, and click **People** (or go to `/admin`). Type
the person's name and click **Create key**. You'll get a ready-to-send message with their key and these setup steps.
**The key is only shown once.** If someone loses theirs, click **New key**. **Remove** deletes the person and
their data.

**Limits:** Cloudflare's free plan allows about 1,000 storage writes a day for everyone combined. The site only
saves when something changed (or once an hour, to keep "Synced … ago" accurate), so it comfortably fits around
20 people.

**Updating the site** after changing the code: `npm run deploy` (or `npm run setup` again).

---

## Hosting your own copy (advanced)

Want your own separate site instead of using someone else's? You'll need **Node.js 20+** and a free
**Cloudflare** account. The setup script handles everything else.

1. **Install Node.js** (LTS version):
   - **Windows:** installer from https://nodejs.org, or `winget install OpenJS.NodeJS.LTS`
   - **Mac:** installer from https://nodejs.org, or `brew install node`
   - **Linux:** follow https://nodejs.org/en/download (the "nvm" option works on any distro)
2. **Download this project** (Step 1 above), or `git clone https://github.com/faarisaahmed/gclass.git`
3. **Open a terminal in the project folder** (the one with `package.json`):
   - **Windows:** in File Explorer, click the address bar, type `cmd`, press Enter.
     (In PowerShell, if you see *"running scripts is disabled"*, type `npm.cmd` instead of `npm`.)
   - **Mac:** open Terminal, type `cd ` (with a space), drag the folder onto the window, press Enter.
   - **Linux:** right-click in the folder and choose **Open in Terminal**.
4. Run **`npm run setup`**. It signs you in to Cloudflare in your browser (you can create a free account there),
   asks a few questions, publishes your site, and prints your **site URL** and **owner key** (also saved in
   `MY-SITE.txt`).
   - If it says you need a **workers.dev subdomain**: go to https://dash.cloudflare.com, click **Workers & Pages**,
     pick a subdomain, then run `npm run setup` again.
5. **Load the extension** (Step 2 above). Setup has already filled in your site URL and key for you.
6. To use your own site's link in the extension by default, change `DEFAULT_URL` in `extension/background.js`
   and `extension/popup.js`.

Your personal settings (`wrangler.toml`, `.setup.json`, `MY-SITE.txt`, `extension/config.js`) are ignored by git.

---

## For developers

| Path | What it is |
|---|---|
| `src/index.js` | The Cloudflare Worker: the site, People admin page, per-person storage, and `/api/*` endpoints. |
| `extension/` | Manifest V3 extension. `background.js` runs the sync; `content.js` scrapes Classroom pages. |
| `scripts/setup.mjs` | Cross-platform setup for hosting your own copy. |
| `wrangler.example.toml` | Template that setup copies to `wrangler.toml`. |

The scraper targets Classroom's To-do page (`/a/not-turned-in/all`) and assignment pages
(`/c/<class>/a/<id>/details`). Classroom's CSS class names change from time to time. If scraping breaks,
`content.js` has the selectors, and each one has a text-based fallback. The owner can read a person's page
outline at `/api/debug?name=list-assigned&user=<id>` after that person clicks **Sync now**.
