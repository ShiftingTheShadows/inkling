# Inkling MCP server

Create and edit Inkling characters from a Claude conversation.

## How it works

Inkling stores everything in browser IndexedDB, which nothing outside the tab can reach. The bridge is the Railway sync backend in `../server`:

```
Claude  ──►  inkling-mcp  ──►  /api/sync  ──►  Postgres
                                                  │
Inkling tab  ◄── pull + reload ◄── polls /api/sync/meta every 60s
```

So a character created here shows up in the app within about a minute, or immediately if you hit **Sync now** in Settings.

## Setup

Requires the sync server deployed and Railway sync enabled in the app.

1. `npm install` in this directory.
2. Register the server, substituting your own values from **Settings → Sync → Railway**:

```bash
claude mcp add inkling -s user \
  -e INKLING_SYNC_URL=https://your-app.up.railway.app \
  -e INKLING_SYNC_TOKEN=your-sync-token \
  -- node C:/Users/shand/HMM/mcp/index.js
```

The token is stored in your Claude config in plaintext. It grants full read and write access to your entire backup — treat it like a password and never commit it.

For **Claude Desktop**, add it to `claude_desktop_config.json` instead:

```json
"inkling": { "command": "node", "args": ["C:\\Users\\shand\\HMM\\mcp\\index.js"] }
```

On the Microsoft Store (MSIX) build of Claude Desktop, that file is **not** in `%APPDATA%\Claude`. A stale copy often lingers there and editing it does nothing. The live one is:

```
%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\claude_desktop_config.json
```

Fully quit Claude Desktop from the tray and relaunch — it reads the config only at startup.

3. Redeploy the sync server. This MCP server needs the `revision` column added in `server/index.js`; an older deployment will reject writes with a 400.

## Tools

| Tool | What it does |
|---|---|
| `inkling_status` | Connection check plus counts. Start here if something misbehaves. |
| `inkling_list_characters` | All bots — id, name, tags, message count. Optional `search`. |
| `inkling_get_character` | One bot in full. Avatar omitted unless `include_avatar: true`. |
| `inkling_create_character` | New bot. Needs `name` and `first_message`. |
| `inkling_update_character` | Patch fields; anything you don't pass is left alone. |
| `inkling_delete_character` | Deletes the bot **and its chat history**. Requires `confirm: true`. |

Characters can be addressed by id or by name. An ambiguous name is an error rather than a guess.

## Why writes use a revision

The backend stores the whole backup as one JSON blob per token. A write is therefore never "insert a character" — it is "replace everything". A write built from a stale read would roll back any chat saved from the browser in between.

Every mutating tool does read → apply → write, sending the revision it read. If the blob changed in between the server returns 409 and the tool replays against fresh data. `test/run.js` covers this: it forces an external write mid-flight and asserts both changes survive.

## Tests

```bash
npm test
```

Runs the real MCP server over stdio against an in-memory fake of the sync backend — no Postgres, no credentials, nothing touches your real data.
