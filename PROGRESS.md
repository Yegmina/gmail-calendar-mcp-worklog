# Gmail, Calendar, Tasks, and Cursor MCP — work log

Chronological record of design decisions, failures, and fixes while wiring **personal Gmail**, **Google Calendar**, and **Google Tasks** to **Cursor** via a **local stdio MCP** on a remote Linux host (for example SSH to `srv1359027`), plus optional **Google-hosted Gmail MCP**.

**Owner / Git author:** [Yegmina](https://github.com/Yegmina) (Yehor Tereshchenko).  
**Date of this document:** 2026-05-06.

---

## 1. Goals

- Use **Gmail**, **Google Calendar**, and **Google Tasks** from **Cursor** when the workspace is on **SSH** (token and Python must run on the server).
- Support **read** mail and calendar, **write** calendar (create/delete events), and **read/write** Tasks through MCP tools; Gmail **write** was verified via API (draft round-trip) but MCP still exposes Gmail **read** tools only for agents.
- Keep **GCP** for this integration **separate** from the StudyShorts / Play billing project (see `docs/gcp-isolation.md`).

---

## 2. Architecture (final)

| Piece | Role |
|--------|------|
| **GCP project** (“Gmail MCP Personal”, id example `gmail-mcp-personal-495219`) | Enables **Gmail API**, **Google Calendar API**, **Google Tasks API**; OAuth consent; Desktop + Web clients. |
| **Desktop OAuth client JSON** | Saved as `~/.cursor/secrets/gmail_desktop_oauth.json` — used for **paste-redirect** auth on the server (`http://localhost` redirect). |
| **User token** | `~/.cursor/secrets/gmail_user_token.json` — refresh token + scopes; **chmod 600**; never commit. |
| **`gmail-local` MCP** | Stdio: `python gmail_mcp_stdio_server.py` on the **same machine** as the token (Critical for SSH). |
| **Hosted `gmail` MCP** | Optional: `https://gmailmcp.googleapis.com/mcp/v1` with **Web** client env `GMAIL_MCP_*` — separate OAuth in Cursor. |

---

## 3. OAuth scopes (evolution)

### 3.1 Early / minimal

- `gmail.readonly`, `calendar.events`, `calendar.readonly`
- **Issue:** `calendar.events` alone did **not** allow `calendarList.list` → **`list_calendars`** returned **403 insufficient scopes**.
- **Fix:** add **`calendar.readonly`** (in addition to `calendar.events`) so calendar list + events both work.

### 3.2 Broaden to “full” Gmail + Calendar

- Attempted **`https://www.googleapis.com/auth/gmail`** + **`https://www.googleapis.com/auth/calendar`**.
- **Issue (user-facing):** Google OAuth **`invalid_scope`** — response indicated **`…/auth/gmail`** was **invalid** for that client/consent configuration while **`calendar` was valid**.
- **Cause (typical):** `auth/gmail` not registered on consent **Data access**, or Gmail API / scope mismatch; full `gmail` is also a heavy scope.

### 3.3 Gmail and Calendar on the Desktop token

- **`https://www.googleapis.com/auth/gmail.modify`** — broad mail operations (read, compose, send, mutate) without using the `auth/gmail` string that failed for this project.
- **`https://www.googleapis.com/auth/calendar`** — full calendar access for listing calendars and event CRUD.

**GCP:** Under **Google Auth Platform → Data access**, add (and save) those URLs. **Gmail API** and **Google Calendar API** must be enabled.

### 3.4 Google Tasks

- **`https://www.googleapis.com/auth/tasks`** — list task lists, list tasks, create/update/delete tasks (same user token as Gmail and Calendar).
- **Enable** the **Google Tasks API** in the same GCP project as the Desktop client. Opening the Tasks API page in the console and clicking enable is enough; the API id is `tasks.googleapis.com`.
- Put the same scope URL on the OAuth consent **Data access** screen. If the scope is missing, OAuth may succeed for mail and calendar but Task calls return **403** with “insufficient authentication scopes” until you add the scope and run `gmail_list_recent.py --auth` again.

**Re-consent:** After any scope change, run `gmail_list_recent.py --auth` on the host that holds `gmail_user_token.json`, then reload Cursor MCP so tools use the refreshed token.

---

## 4. Technical fixes (OAuth client + libraries)

| Problem | Mitigation |
|---------|------------|
| `redirect_uri` missing | Set `flow.redirect_uri` from client JSON’s `redirect_uris[0]` (e.g. `http://localhost`). |
| `InsecureTransportError` for localhost | `OAUTHLIB_INSECURE_TRANSPORT=1` in `google_personal_oauth.py` for local redirect only. |
| Desktop flow on headless server | Open auth URL on **any** browser; copy **full** redirect URL (with `code=`) back to SSH **paste** prompt. |
| **Security** | **Never** paste `code=` URLs into chat or public logs — one-time credentials. |

---

## 5. MCP tool surface (`gmail-local`)

Implemented in `scripts/gmail_mcp_stdio_server.py` (FastMCP):

**Gmail (read):** `list_labels`, `search_threads`, `get_thread`, `get_message_body` (full decoded body + attachment metadata)  
**Calendar (read/write):** `list_calendars`, `list_events`, `create_event`, `delete_event`  
**Tasks (read/write):** `list_tasklists`, `list_tasks`, `create_task`, `update_task`, `delete_task` (scope `https://www.googleapis.com/auth/tasks`; enable **Tasks API** + re-consent)

**Note:** Gmail **write** (e.g. drafts) is not exposed as MCP tools yet; it was validated with `scripts/gmail_mcp_rw_selftest.py` using the same token.

Cursor exposes this server as MCP id **`user-gmail-local`** (internal) with display name **`gmail-local`**.

---

## 6. Validation steps

1. **`gmail_list_recent.py --auth`** — exchange code; then list mail.
2. **`gmail_mcp_rw_selftest.py`** — calendar create/delete + Gmail draft create/delete (API parity).
3. **`gmail_mcp_integration_check.sh`** — local checks for `mcp.json`, optional hosted env vars, and (without calling Google) that the saved token’s `scopes` list includes Gmail, Calendar, and Tasks when `gmail_user_token.json` exists.
4. **Cursor MCP live calls** — for example `list_calendars`, `search_threads`, `create_event`, `delete_event`, and task tools such as `list_tasklists` / `list_tasks` once the token includes the Tasks scope.

---

## 7. Host layout (reference)

Paths were originally under `/root/.cursor/` on a VPS; the same layout works under `$HOME/.cursor/` on any user.

- `secrets/gmail_desktop_oauth.json` — Desktop client (download from GCP).  
- `secrets/gmail_user_token.json` — user token (generated).  
- `secrets/gmail_mcp.env` — **Web** client ID/secret for **hosted** MCP (optional).  
- `gmail-venv/` — virtualenv with `requirements.txt` dependencies.  
- `scripts/*.py` — OAuth helper, MCP server, tests.

---

## 8. Follow-ups (optional)

- Add MCP tools for Gmail **draft** / **send** if agents need mail write without a side script.
- Move **hosted** `gmail` `CLIENT_SECRET` out of committed `mcp.json` into env-only (secrets hygiene).
- If **`invalid_scope`** reappears on Workspace / school accounts (`@metropolia.fi`), verify admin policies for sensitive scopes.

---

## 9. Repository contents

| Path | Purpose |
|------|---------|
| `README.md` | Quick setup and links. |
| `PROGRESS.md` | This history. |
| `requirements.txt` | Python deps for MCP + Google APIs. |
| `config/*.example` | Safe templates — no real secrets. |
| `scripts/` | Runnable tooling (copy or symlink into `~/.cursor/scripts`). |
| `docs/gcp-isolation.md` | Project separation rule. |

---

*End of work log.*
