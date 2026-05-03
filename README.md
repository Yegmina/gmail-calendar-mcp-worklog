# gmail-calendar-mcp-worklog

Documentation and scripts for **Gmail + Google Calendar** integration with **Cursor**, including a **stdio MCP** (`gmail-local`) suitable for **SSH / remote** workspaces.

**Author:** [Yegmina](https://github.com/Yegmina)

## What’s inside

- **`PROGRESS.md`** — Full **history** of scope changes, OAuth errors, and validation (start here for the narrative).
- **`scripts/`** — OAuth helper, MCP server, integration check, read/write self-test.
- **`config/`** — **`mcp.json.example`** and **`gmail_mcp.env.example`** (placeholders only).
- **`docs/gcp-isolation.md`** — Keep this MCP in a **dedicated** GCP project, not mixed with unrelated billing apps.

## Quick setup (summary)

1. Create a GCP project; enable **Gmail API** and **Google Calendar API**.
2. Configure **OAuth consent** (external + test users as needed). **Data access** must include:
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/calendar`
3. Create a **Desktop** OAuth client; download JSON → `~/.cursor/secrets/gmail_desktop_oauth.json` (chmod 600).
4. Python venv: `python3 -m venv ~/.cursor/gmail-venv && ~/.cursor/gmail-venv/bin/pip install -r requirements.txt`
5. Install scripts under `~/.cursor/scripts/` (copy from this repo or symlink).
6. On the **same host** as Cursor remote:  
   `~/.cursor/gmail-venv/bin/python ~/.cursor/scripts/gmail_list_recent.py --auth`
7. Merge **`config/mcp.json.example`** into your `~/.cursor/mcp.json` with **absolute** paths to your venv + `gmail_mcp_stdio_server.py`.
8. For **hosted** Gmail MCP, fill `gmail_mcp.env` from **`import_gmail_mcp_oauth_from_console_json.sh`** and use env-based ID/secret in `mcp.json` — see example.

## Verify

From the clone root:

```bash
bash scripts/gmail_mcp_integration_check.sh
~/.cursor/gmail-venv/bin/python scripts/gmail_mcp_rw_selftest.py
```

Paths use `$HOME/.cursor` for secrets and venv by default (`GMAIL_MCP_HOME` can override secrets dir — see `google_personal_oauth.py`).

Then **Cursor → Settings → MCP → gmail-local** and **Reload Window**.

## Security

- Never commit `gmail_user_token.json`, `gmail_desktop_oauth.json`, or `gmail_mcp.env`.
- Do not share OAuth redirect URLs containing `code=`.

## Git commits from a Cursor remote / agent shell

When `CURSOR_AGENT=1`, **git commit** in that environment may append  
`Co-authored-by: Cursor <cursoragent@cursor.com>` to the message. GitHub then shows **Cursor** next to you.

To record commits **only** as Yegmina, use a minimal environment for amend/commit, for example:

```bash
MSG=$(mktemp)
cat >"$MSG" <<'EOF'
Your subject line

Body line one.
EOF
env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/local/bin" \
  GIT_DIR="$(pwd)/.git" GIT_WORK_TREE="$(pwd)" \
  GIT_AUTHOR_NAME=Yegmina GIT_AUTHOR_EMAIL=123106244+Yegmina@users.noreply.github.com \
  GIT_COMMITTER_NAME=Yegmina GIT_COMMITTER_EMAIL=123106244+Yegmina@users.noreply.github.com \
  /usr/bin/git commit -F "$MSG"   # or: commit --amend -F "$MSG"
rm -f "$MSG"
```

Use normal **`git push`** (SSH) yourself — not Cursor Agent push automation.

## Publish to GitHub (run locally as Yegmina)

Do **not** use Cursor Agent automated push; use normal `git` on your machine.

```bash
cd gmail-calendar-mcp-worklog
git init
git add -A
git status   # confirm no *.json secrets or .env
GIT_AUTHOR_NAME=Yegmina GIT_AUTHOR_EMAIL=123106244+Yegmina@users.noreply.github.com \
  git commit -m "Add Gmail/Calendar Cursor MCP docs and scripts"
git branch -M main
git remote add origin https://github.com/Yegmina/gmail-calendar-mcp-worklog.git
git push -u origin main
```

Create the empty repo **gmail-calendar-mcp-worklog** under [github.com/Yegmina](https://github.com/Yegmina) first (no README) if it does not exist.
