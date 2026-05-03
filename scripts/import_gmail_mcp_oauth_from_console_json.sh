#!/usr/bin/env bash
# Write ~/.cursor/secrets/gmail_mcp.env from a Web OAuth client JSON downloaded from GCP.
#
# After you create the client in console (Web application, redirect
# cursor://anysphere.cursor-mcp/oauth/callback), click Download JSON and run:
#
#   bash /root/.cursor/scripts/import_gmail_mcp_oauth_from_console_json.sh ~/Downloads/client_secret_*.json
#
# Or save as ~/.cursor/secrets/gmail_mcp_oauth_client.json and run with no args.

set -euo pipefail

JSON_PATH="${1:-${HOME}/.cursor/secrets/gmail_mcp_oauth_client.json}"
OUT="${HOME}/.cursor/secrets/gmail_mcp.env"
SECRETS_DIR="${HOME}/.cursor/secrets"

if [[ ! -f "$JSON_PATH" ]]; then
  echo "error: file not found: $JSON_PATH" >&2
  echo "" >&2
  echo "Create a Web client in Gmail MCP Personal, download JSON, then:" >&2
  echo "  $0 /path/to/client_secret_....json" >&2
  exit 1
fi

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR" 2>/dev/null || true

python3 - "$JSON_PATH" "$OUT" <<'PY'
import json, os, sys, re

src, dst = sys.argv[1], sys.argv[2]
with open(src, encoding="utf-8") as f:
    data = json.load(f)

section = data.get("web") or data.get("installed")
if not section:
    print("error: JSON must contain top-level 'web' (Web client) or 'installed'", file=sys.stderr)
    sys.exit(2)

cid = section.get("client_id")
sec = section.get("client_secret")
if not cid or not sec:
    print("error: missing client_id or client_secret in JSON", file=sys.stderr)
    sys.exit(2)

redirects = section.get("redirect_uris") or []
cursor_ok = any(
    re.match(r"^cursor://anysphere\.cursor-mcp/oauth/callback$", u.strip()) for u in redirects
)
if not cursor_ok:
    print("warning: redirect_uris should include exactly:", file=sys.stderr)
    print("  cursor://anysphere.cursor-mcp/oauth/callback", file=sys.stderr)
    print("(Add it in Google Cloud → Clients → your Web client → Authorized redirect URIs.)", file=sys.stderr)

lines = [
    "# Generated from console OAuth JSON; do not commit. chmod 600.",
    f'export GMAIL_MCP_CLIENT_ID="{cid}"',
    f'export GMAIL_MCP_CLIENT_SECRET="{sec}"',
    "",
]
with open(dst, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
os.chmod(dst, 0o600)
print(f"Wrote {dst}")
print("Restart Cursor (or open a new login shell) so MCP picks up the env vars.")
PY

chmod 600 "$OUT"
echo ""
echo "Run: bash \"$(dirname "$0")/gmail_mcp_integration_check.sh\""
