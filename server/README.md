# Inkling sync server

A tiny Express + Postgres API that replaces GitHub Gist as a sync backend.
It stores one JSON blob per secret token — the same shape the app already
builds for Gist sync — so pushing from one device and pulling from another
restores everything (characters, chats, personas, settings, lorebook).

There's no per-user schema and no accounts: the token itself (hashed with
SHA-256 before it touches the database) is what scopes your data. Anyone
who knows your token can read/write your backup, so treat it like a
password — pick something long and random, not `inkling123`.

## Deploy to Railway

1. On [railway.app](https://railway.app), **New Project → Deploy from GitHub repo** and pick this repo.
2. On the service Railway creates, open **Settings → Root Directory** and set it to `server`. Redeploy.
3. In the same project, **New → Database → Add PostgreSQL**. Railway automatically injects `DATABASE_URL` into the other service in the project — no manual wiring needed.
4. Once it's deployed, go to **Settings → Networking → Generate Domain** on the server service to get a public URL (something like `inkling-sync-production.up.railway.app`).
5. In the Inkling app: **Settings → Sync → Railway tab**, paste that URL as the Service URL, and make up a Sync Token (8+ characters — this is your own secret, not a Railway credential). Use the same URL + token on every device you want synced.

## Local dev

```
cd server
npm install
DATABASE_URL=postgres://... npm start
```
