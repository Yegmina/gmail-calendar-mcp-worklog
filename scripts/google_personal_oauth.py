"""Shared OAuth paths and scopes for personal Gmail + Google Calendar (Desktop client).

Token file: ~/.cursor/secrets/gmail_user_token.json
Client JSON: ~/.cursor/secrets/gmail_desktop_oauth.json

GCP (project Gmail MCP Personal): enable Gmail API + Google Calendar API.

Scopes are broad mail + calendar access for agents. We use **gmail.modify** (not …/auth/gmail):
Google may return `invalid_scope` for `…/auth/gmail` until that exact scope is on the
consent screen; **gmail.modify** covers read/send/label/trash for the Gmail API in practice.

After changing scopes in GCP Data access, re-consent:
  ~/.cursor/gmail-venv/bin/python ~/.cursor/scripts/gmail_list_recent.py --auth
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")

# gmail.modify: read + compose + send + mutate mail (avoid …/auth/gmail — often invalid_scope if not on consent).
SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
]

DEFAULT_SECRETS_DIR = Path(os.environ.get("GMAIL_MCP_HOME", Path.home() / ".cursor" / "secrets"))
CLIENT_FILE = DEFAULT_SECRETS_DIR / "gmail_desktop_oauth.json"
TOKEN_FILE = DEFAULT_SECRETS_DIR / "gmail_user_token.json"


def auth_help_message() -> str:
    return (
        "No valid Google token (Gmail.modify + Calendar) on this host. On this machine run once:\n"
        "  ~/.cursor/gmail-venv/bin/python ~/.cursor/scripts/gmail_list_recent.py --auth\n"
        "Requires ~/.cursor/secrets/gmail_desktop_oauth.json; creates gmail_user_token.json.\n"
        "In GCP enable Gmail + Calendar APIs; Data access must include auth/gmail.modify + auth/calendar, then re-auth."
    )


def scopes_sufficient(creds: Credentials) -> bool:
    have = set(creds.scopes or [])
    return all(s in have for s in SCOPES)


def load_creds_interactive() -> Credentials:
    if not CLIENT_FILE.is_file():
        print(f"Missing OAuth client file: {CLIENT_FILE}", file=sys.stderr)
        sys.exit(2)

    flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_FILE), SCOPES)
    uris = flow.client_config.get("redirect_uris") or []
    flow.redirect_uri = uris[0] if uris else "http://localhost"
    auth_url, _ = flow.authorization_url(prompt="consent", access_type="offline")
    print("Open this URL in a browser (any machine where you can sign in to Google):\n")
    print(auth_url)
    print(
        "\nAfter you approve, the browser may show a connection error for localhost — "
        "that is OK. Copy the **entire** URL from the address bar (must contain code=) "
        "and paste it below.\n"
    )
    response = input("Paste redirect URL or raw code value: ").strip()
    if not response:
        print("No input.", file=sys.stderr)
        sys.exit(1)
    if response.startswith("http"):
        flow.fetch_token(authorization_response=response)
    else:
        flow.fetch_token(code=response)
    creds = flow.credentials
    TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")
    os.chmod(TOKEN_FILE, 0o600)
    return creds


def get_creds(*, require_full_scopes: bool = True) -> Credentials:
    creds: Credentials | None = None
    if TOKEN_FILE.is_file():
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")
        if require_full_scopes and not scopes_sufficient(creds):
            print(
                "Token refreshed but missing required Gmail/Calendar scopes. "
                "Run: ~/.cursor/gmail-venv/bin/python ~/.cursor/scripts/gmail_list_recent.py --auth",
                file=sys.stderr,
            )
            sys.exit(2)
        return creds
    if creds and creds.valid:
        if require_full_scopes and not scopes_sufficient(creds):
            print(
                "Saved token does not match current scopes (need full Gmail + Calendar). Run with --auth:\n"
                "  ~/.cursor/gmail-venv/bin/python ~/.cursor/scripts/gmail_list_recent.py --auth",
                file=sys.stderr,
            )
            sys.exit(2)
        return creds
    return load_creds_interactive()


def credentials_for_mcp() -> Credentials:
    if not TOKEN_FILE.is_file():
        raise RuntimeError(auth_help_message())
    creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")
    if not creds.valid:
        raise RuntimeError(auth_help_message())
    if not scopes_sufficient(creds):
        raise RuntimeError(
            auth_help_message()
            + "\n(Re-run gmail_list_recent.py --auth after widening scopes in GCP Data access.)"
        )
    return creds
