#!/usr/bin/env bash
# Sanity-check Gmail + Calendar MCP (env + config). Does not call Google with secrets.
set -euo pipefail

CUR="${HOME}/.cursor"
MCP_JSON="${CUR}/mcp.json"
TOKEN_JSON="${CUR}/secrets/gmail_user_token.json"

echo "== Gmail + Calendar MCP (Cursor) integration check =="
echo "(Using CUR=${CUR})"
echo

if [[ -f "$MCP_JSON" ]] && grep -q '"gmail-local"' "$MCP_JSON"; then
  echo "[ok] $MCP_JSON defines mcpServers.gmail-local (stdio: Gmail + Calendar)"
else
  echo "[!!] gmail-local missing from $MCP_JSON (needed for SSH token MCP)"
fi

if [[ -f "$MCP_JSON" ]] && grep -q '"gmail"' "$MCP_JSON"; then
  echo "[ok] $MCP_JSON defines mcpServers.gmail (hosted, optional)"
else
  echo "[--] hosted gmail not in mcp.json (optional)"
fi

if [[ -n "${GMAIL_MCP_CLIENT_ID:-}" ]]; then
  echo "[ok] GMAIL_MCP_CLIENT_ID is set"
else
  echo "[!!] GMAIL_MCP_CLIENT_ID unset — Cursor cannot start hosted Gmail MCP OAuth"
fi

if [[ -n "${GMAIL_MCP_CLIENT_SECRET:-}" ]]; then
  echo "[ok] GMAIL_MCP_CLIENT_SECRET is set"
else
  echo "[!!] GMAIL_MCP_CLIENT_SECRET unset (optional if you only use gmail-local)"
fi

if [[ -f "${CUR}/secrets/gmail_mcp.env" ]]; then
  echo "[ok] ${CUR}/secrets/gmail_mcp.env exists (source it or rely on .bashrc)"
else
  echo "[--] No gmail_mcp.env — copy config/gmail_mcp.env.example → ${CUR}/secrets/gmail_mcp.env"
  echo "    or: bash scripts/import_gmail_mcp_oauth_from_console_json.sh /path/to/client_secret.json"
fi

echo
echo "Endpoint probe (no auth, expect 4xx):"
code=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "https://gmailmcp.googleapis.com/mcp/v1" \
  -H "Content-Type: application/json" -d '{}' || echo "err")
echo "  POST https://gmailmcp.googleapis.com/mcp/v1 → HTTP $code"

echo
echo "Google Calendar + Gmail (Desktop token uses calendar + gmail.modify):"
echo "  bash scripts/gcp_enable_personal_google_apis.sh"
echo "  Console → Data access: add (and keep) scope URLs:"
echo "    https://www.googleapis.com/auth/gmail.modify"
echo "    https://www.googleapis.com/auth/calendar"
echo

if [[ -f "$TOKEN_JSON" ]] && command -v python3 &>/dev/null; then
  if python3 -c "
import json, sys
p = '''$TOKEN_JSON'''
d = json.load(open(p))
scopes = set(d.get('scopes') or [])
need = {
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
}
ok = need.issubset(scopes)
print('  [ok] token has Gmail + Calendar scopes' if ok else '  [!!] token missing scope(s) — run gmail_list_recent.py --auth; add scopes in Data access if needed')
sys.exit(0 if ok else 1)
" 2>/dev/null; then
    :
  else
    python3 -c "
import json
p = '''$TOKEN_JSON'''
d = json.load(open(p))
print('  [--] scopes in token:', d.get('scopes'))
" 2>/dev/null || true
  fi
fi

echo
echo "Desktop OAuth test script (Gmail + Calendar):"
VENV_PY="${CUR}/gmail-venv/bin/python"
if [[ -f "$TOKEN_JSON" ]]; then
  echo "  [ok] gmail_user_token.json present — try:"
  echo "    $VENV_PY scripts/gmail_list_recent.py --max 3"
  echo "    $VENV_PY scripts/gmail_list_recent.py --calendar-only"
else
  echo "  [--] No gmail_user_token.json — Desktop API: place gmail_desktop_oauth.json, enable APIs, then:"
  echo "    $VENV_PY scripts/gmail_list_recent.py --auth"
fi

echo ""
echo "SSH/root stdio MCP (gmail-local):"
if [[ -f "$TOKEN_JSON" ]]; then
  echo "  [ok] gmail_user_token.json — reload Cursor if you changed scopes."
else
  echo "  [--] Missing gmail_user_token.json — on THIS host run:"
  echo "       $VENV_PY scripts/gmail_list_recent.py --auth"
fi

echo
echo "Next: Settings → MCP → gmail-local on → Reload Window."
echo "MCP tools include list_calendars, list_events, create_event, delete_event."
