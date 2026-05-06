# Cursor SDK Telegram Bot

This project runs a local Cursor SDK agent behind the Telegram bot
`@Manager4Yehor_bot`. The agent uses inline stdio MCP server definitions for:

- `gmail-local` — Gmail + Google Calendar via `/root/.cursor/scripts/gmail_mcp_stdio_server.py`
- `telegramMainFi` — Telegram user session via `/root/.cursor/telegram-mcp-cursor.js`

Run it on the same VPS that already has the Gmail token and Telegram session.

## Environment

Copy `.env.example` to `.env`, fill secrets, and keep the file uncommitted:

```bash
cp .env.example .env
chmod 600 .env
```

Required:

- `CURSOR_API_KEY`
- `MANAGER4YEHOR_BOT_TOKEN`
- `TG_APP_ID`
- `TG_API_HASH`

Optional:

- `CURSOR_MODEL_ID` (defaults to `composer-2-fast`)
- `ALLOWED_TELEGRAM_USER_IDS` (comma-separated; empty allows all)
- `OPENAI_API_KEY` and `VOICE_TRANSCRIPTION_MODEL` for voice transcription
- `DEFAULT_TIMEZONE` (defaults to `Europe/Helsinki`)
- `DEFAULT_CALENDAR_ID` (defaults to `primary`)
- `EMAIL_MONITOR_ENABLED`, `EMAIL_MONITOR_INTERVAL_MINUTES`, `EMAIL_MONITOR_LOOKBACK_HOURS`, `TELEGRAM_NOTIFY_CHAT_IDS`, `EMAIL_MONITOR_STATE_PATH` (see **Email monitor** below)
- `MEMORY_AGENT_UPDATES` (default `true`) — after each reply, a small agent pass may append `data/soul.md` and `data/memory.md`
- path overrides for the Gmail and Telegram MCP scripts

## Email monitor (proactive Gmail)

The bot starts a timer (first run **~30s** after start, then every `EMAIL_MONITOR_INTERVAL_MINUTES`, default **60**) that runs a **local Cursor SDK** agent with the same `gmail-local` MCP. It searches `newer_than:Nh` (`EMAIL_MONITOR_LOOKBACK_HOURS`, default **2**), classifies threads, may create calendar events for clear self-registrations, and sends short alerts to Telegram.

**Watermarks:** State file stores `threadWatermarks` (Gmail thread id → last processed **message** id) so **new mail in an existing thread** can alert again. Legacy state files that only had `seenThreadIds` are migrated once (watermarks cleared so threads are re-evaluated).

**Notify targets:** Alerts are dropped if there is no chat id to send to. Targets are the union of `TELEGRAM_NOTIFY_CHAT_IDS`, any chat that has messaged the bot (stored in the state file), and `ALLOWED_TELEGRAM_USER_IDS` (treated as DM chat ids; for **groups**, set `TELEGRAM_NOTIFY_CHAT_IDS` to the group id). On startup you may see: `Email monitor has no notify chat yet` — send `/start` or any message to the bot from that chat, or set env vars.

**Logs:** One JSON line per cycle when work runs, for example `email_monitor_cycle` with `alertCount`, `runId`, `durationMs`. Failures log `email_monitor_agent_not_finished` or `email_monitor_json_parse_failed`. Follow live: `docker compose logs -f manager4yehor-sdk-bot`.

## Persistent context (`data/soul.md`, `data/memory.md`)

Copy examples to writable names (or create your own):

```bash
mkdir -p data
cp data/soul.example.md data/soul.md
cp data/memory.example.md data/memory.md
```

Planner and executor prompts include these files (if present). Personal copies stay gitignored via `data/*` with exceptions for `*.example.md`.

- **`/remember <text>`** — runs only the memory agent pass and appends bullets to `memory.md` when the model proposes lines (never updates `soul` on this path).

After a normal reply, if `MEMORY_AGENT_UPDATES=true`, an async pass may update `memory.md` and occasionally append to `soul.md` (see `MEMORY_AGENT_UPDATES` above).

## MCP Health Test

`npm run mcp:health` asks the SDK agent to call (among others):

- `gmail-local.list_calendars`
- `gmail-local.search_threads`
- `gmail-local.get_thread` (when a thread exists)
- `gmail-local.get_message_body` (smoke test with a small `max_body_chars`)
- `telegramMainFi.tg_me`
- `telegramMainFi.tg_dialogs`

It should return a compact OK/FAIL report.

## Debugging with Telegram MCP (`tg_dialog`)

From Cursor on this host (with `telegramMainFi` configured in `~/.cursor/mcp.json`), call **tg_dialog** with the **dialog name** shown in `tg_dialogs` (e.g. the bot or a user chat) to pull recent messages — useful to compare what you sent with bot logs and `email_monitor_*` lines.

Combine with:

- `docker compose logs -f manager4yehor-sdk-bot`
- `data/email-monitor-state.json` (path from `EMAIL_MONITOR_STATE_PATH`) for watermarks and registered notification chats
- `data/soul.md` / `data/memory.md` for persistent context

## Commands

```bash
npm install
npm run mcp:health
npm run dev
```

## Deploying (staging)

Production-style deploys are **not** driven by shelling into the VPS and running Compose by hand. They go through Git:

1. Merge or push your changes to the **`staging`** branch on [github.com/Yegmina/gmail-calendar-mcp-worklog](https://github.com/Yegmina/gmail-calendar-mcp-worklog).
2. GitHub Actions runs [`.github/workflows/deploy-staging.yml`](../.github/workflows/deploy-staging.yml) on every push to `staging`.
3. That workflow **POSTs** to the Actions secret **`STAGING_DEPLOY_WEBHOOK_URL`** (your host/PaaS redeploy hook). If the secret is unset, the job exits successfully after a notice — configure the secret so the server pulls the new image and restarts.

So the normal path is: **commit → push to `staging` → webhook redeploys the bot**. Use Docker Compose locally or on the server only for dev, debugging, or if you intentionally bypass CI.

## Docker

The Docker image installs its own Node dependencies and a Python venv at
`/opt/gmail-venv` for `gmail-local`. It mounts the host Cursor and Telegram MCP
state so the container can reuse existing tokens and sessions.

Local or ad-hoc:

```bash
docker compose up -d --build
docker compose logs -f manager4yehor-sdk-bot
```

Mounted host paths:

- `/root/.cursor` for Gmail token, MCP scripts, and Telegram MCP binary
- `/root/.telegram-mcp` for Telegram user session data

The compose file overrides:

- `GMAIL_MCP_PYTHON=/opt/gmail-venv/bin/python`
- `TELEGRAM_NODE=/usr/local/bin/node`

This avoids depending on the host Python venv inside the container.

## Safety Rules

The planner/executor prompts are conservative:

- Read-only Gmail, Calendar, and Telegram inspection is allowed.
- Calendar create/delete is allowed only for explicit calendar requests.
- Every successful calendar create/delete is reported back in Telegram as a visible calendar update notification.
- `telegramMainFi.tg_send` is allowed only when the user clearly asks to send a message and names the target dialog.
- The Gmail MCP currently exposes read-only tools only, so the bot must not attempt Gmail send/delete/mutation.
- The SDK agent is told not to edit files, commit, push, install packages, or change system configuration; **soul** / **memory** files are updated only by separate bot-controlled passes with JSON output — not via the main executor tools.
- The bot keeps a short in-memory chat history so follow-ups like “just create it” can use previous date/time details.
- Calendar creation defaults to primary calendar and Europe/Helsinki when the user gives enough scheduling context but omits those fields.

## Voice Messages

Voice messages are supported when `OPENAI_API_KEY` is set. The bot downloads the Telegram voice file, transcribes it with `VOICE_TRANSCRIPTION_MODEL`, echoes the transcript, then sends the transcript through the same planner/executor flow as text messages.

If `OPENAI_API_KEY` is not configured, the bot replies with a clear voice transcription error and does not call the Cursor SDK.

## Image Messages

Photo messages and image documents are downloaded from Telegram and sent to the
Cursor SDK as image inputs. Captions become the user instruction. If there is no
caption, the bot asks the agent to analyze the attached image and act only when
the instruction is clear.

This is intended for flows like:

- screenshot of a calendar/email invite + “Add this”
- screenshot + “summarize”
- screenshot + “what time is this event?”
