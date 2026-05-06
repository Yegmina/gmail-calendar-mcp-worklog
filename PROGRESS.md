# Gmail + Google Calendar + Cursor MCP — work log

Chronological record of design decisions, failures, and fixes while wiring **personal Gmail** and **Google Calendar** to **Cursor** via a **local stdio MCP** on a remote Linux host (e.g. SSH to `srv1359027`), plus optional **Google-hosted Gmail MCP**.

**Owner / Git author:** [Yegmina](https://github.com/Yegmina) (Yehor Tereshchenko).  
**Date of this document:** 2026-05-03.

---

## 1. Goals

- Use **Gmail** and **Google Calendar** from **Cursor** when the workspace is on **SSH** (token and Python must run on the server).
- Support **read** mail and calendar, and **write** calendar (create/delete events); Gmail **write** verified via API (draft round-trip) — MCP initially exposed Gmail **read** tools only.
- Keep **GCP** for this integration **separate** from the StudyShorts / Play billing project (see `docs/gcp-isolation.md`).

---

## 2. Architecture (final)

| Piece | Role |
|--------|------|
| **GCP project** (“Gmail MCP Personal”, id example `gmail-mcp-personal-495219`) | Enables **Gmail API**, **Google Calendar API**; OAuth consent; Desktop + Web clients. |
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

### 3.3 Final Desktop token scopes

- **`https://www.googleapis.com/auth/gmail.modify`** — broad mail operations (read, compose, send, mutate) without using the `auth/gmail` string that failed for this project.
- **`https://www.googleapis.com/auth/calendar`** — full calendar access for listing calendars and event CRUD.

**GCP:** Under **Google Auth Platform → Data access**, add (and save) those exact URLs. **Gmail API** + **Google Calendar API** must be enabled.

**Re-consent:** After any scope change, run `gmail_list_recent.py --auth` on the host that holds the token.

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

**Note:** Gmail **write** (e.g. drafts) is not exposed as MCP tools yet; it was validated with `scripts/gmail_mcp_rw_selftest.py` using the same token.

Cursor exposes this server as MCP id **`user-gmail-local`** (internal) with display name **`gmail-local`**.

---

## 6. Validation steps

1. **`gmail_list_recent.py --auth`** — exchange code; then list mail.
2. **`gmail_mcp_rw_selftest.py`** — calendar create/delete + Gmail draft create/delete (API parity).
3. **`gmail_mcp_integration_check.sh`** — local checks: `mcp.json`, env vars, token scopes (no Google calls with secrets).
4. **Cursor MCP live calls** — e.g. `list_calendars`, `search_threads`, `create_event`, `delete_event` via the agent (confirmed working).

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
