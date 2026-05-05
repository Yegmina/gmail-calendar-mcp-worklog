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
- path overrides for the Gmail and Telegram MCP scripts

## Commands

```bash
npm install
npm run mcp:health
npm run dev
```

## Docker

The Docker image installs its own Node dependencies and a Python venv at
`/opt/gmail-venv` for `gmail-local`. It mounts the host Cursor and Telegram MCP
state so the container can reuse existing tokens and sessions.

```bash
docker compose up -d --build
docker compose logs -f manager4yehor-bot
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
- The SDK agent is told not to edit files, commit, push, install packages, or change system configuration.
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

## MCP Health Test

`npm run mcp:health` asks the SDK agent to call:

- `gmail-local.list_calendars`
- `gmail-local.search_threads`
- `telegramMainFi.tg_me`
- `telegramMainFi.tg_dialogs`

It should return a compact OK/FAIL report.
