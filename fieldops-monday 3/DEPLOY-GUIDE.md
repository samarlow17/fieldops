# FieldOps × monday.com — Deploy Guide

A phone app for your team that reads jobs straight from your **CCH – Maintenance Dashboard** board. The admin opens a job and assigns a **Contractor + scheduled date/time** (written back to Monday). The assigned person opens the app, sees only their jobs, and uploads photos that land on that job's **Evidence** column in Monday.

Your Monday API token stays on the server and is never sent to anyone's phone. Operatives log in with a simple passcode — they don't need a Monday account.

This has been tested end-to-end against a simulated Monday API. The one thing left is hosting it, because it needs a small always-on server to hold your token and talk to Monday.

---

## What's in this folder

- `server.js` — the backend (holds your token, talks to Monday, serves the app)
- `public/index.html` — the app people use
- `users.example.json` — copy to `users.json` to set your admin + operatives
- `.env.example` — where your Monday token goes
- `package.json` — dependencies

---

## Step 1 — Get your Monday API token

1. In Monday, click your avatar (bottom-left) → **Developers** → **My access tokens** (or go to monday.com → Profile → Developers).
2. Copy your personal **API token**. Treat it like a password — it can read and write your boards.

## Step 2 — Set up your users

1. Make a copy of `users.example.json` named **`users.json`**.
2. Edit it:
   - Set the **admin** passcode (this is you / the office).
   - Add one block per operative with their **passcode** and their **contractorId**. The `contractorId` is the number Monday uses for that name in the **Contractor** dropdown. Common ones on your board: `Keith = 8`, `Glen = 108`, `Sam = 111`, `Jamie = 156`. (If you need others, I can pull the full list for you.)
3. Pick passcodes that are unique and not easy to guess.

You can edit `users.json` any time to add or remove operatives — no restart needed.

## Step 3 — Host it (Render, free tier — ~5 minutes)

Render runs a small server for free and gives you an HTTPS web link. Easiest path:

1. Create a free account at **https://render.com**.
2. Put this project folder in a **GitHub repo** (drag-drop upload works), or use Render's "deploy from a folder" option.
3. In Render: **New → Web Service**, point it at the repo.
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. Under **Environment**, add a variable:
   - Key `MONDAY_TOKEN`, value = the token from Step 1.
   - (Optional) Key `BOARD_ID`, value `1652227316` for the CCH board — it's the default, so only needed if you switch boards.
5. Deploy. Render gives you a link like `https://fieldops-xyz.onrender.com`.

> Note on `users.json`: commit your `users.json` to the repo, **or** keep passcodes out of git and instead paste the same JSON into a `USERS_JSON` env var — tell me which you prefer and I'll wire it up. (Other good hosts: Railway, Fly.io, or any Node host. Same two commands, same env var.)

## Step 4 — Use it

1. Open your Render link. Log in with the **admin** passcode.
2. You'll see the jobs from the board. Open one → pick a **contractor**, set the **visit date + time** → **Save assignment**. That writes straight to Monday.
3. Each operative opens the **same link** on their phone, logs in with **their** passcode, and sees only the jobs assigned to them. They tap a job → **Add** photos → the photos appear in that job's **Evidence** column in Monday.
4. On a phone, use the browser's **Add to Home Screen** so it opens like an app.

---

## How permissions work

- **Admin** sees every job, can assign contractor + date/time, and can add photos.
- **Operative** sees only jobs whose Contractor matches their account, can add photos, and **cannot** assign or see other people's jobs. This is enforced on the server, not just hidden in the screen.

## Costs

Render's free tier is enough to run this. One quirk of the free tier: the server "sleeps" after inactivity and takes ~30 seconds to wake on the first request — fine for this use. A few dollars a month removes the sleep if you want it instant.

## Troubleshooting

- **"Could not load jobs"** — the `MONDAY_TOKEN` is missing or wrong, or the board id changed. Check the env var.
- **Operative sees no jobs** — their `contractorId` in `users.json` doesn't match how that job's Contractor is set in Monday. Make sure the admin assigned the job to that exact contractor.
- **Photo upload fails** — usually the token lacks write access; regenerate it in Monday and update the env var.

---

Want me to: pull the **full contractor → id list** so your `users.json` is ready to paste, switch the photo target to a **new dedicated column**, also let operatives **update Works Status**, or walk you through the Render deploy live? Say the word.
