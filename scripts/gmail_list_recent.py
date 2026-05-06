#!/usr/bin/env python3
"""Test Gmail + Google Calendar OAuth and list recent mail (Desktop client JSON).

1. GCP: enable Gmail API + Google Calendar API + Google Tasks API; OAuth Desktop client JSON at
   ~/.cursor/secrets/gmail_desktop_oauth.json (chmod 600).
2. First login (interactive):
     ~/.cursor/gmail-venv/bin/python ~/.cursor/scripts/gmail_list_recent.py --auth
3. Later: same command without --auth lists recent subjects.

Scopes: gmail.modify + calendar + tasks (shared token for stdio MCP).

Does not touch studyshortspayservice.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from googleapiclient.discovery import build

from google_personal_oauth import TOKEN_FILE, get_creds


def _list_upcoming_events(creds, n: int = 5) -> None:
    svc = build("calendar", "v3", credentials=creds)
    now = datetime.now(timezone.utc)
    end = now + timedelta(days=42)
    resp = (
        svc.events()
        .list(
            calendarId="primary",
            timeMin=now.isoformat().replace("+00:00", "Z"),
            timeMax=end.isoformat().replace("+00:00", "Z"),
            maxResults=n,
            singleEvents=True,
            orderBy="startTime",
        )
        .execute()
    )
    events = resp.get("items") or []
    if not events:
        print("Calendar: no upcoming events in the next ~42 days (primary).")
        return
    print(f"Calendar: next {len(events)} event(s) on primary:\n")
    for ev in events:
        eid = ev.get("id", "?")
        summ = ev.get("summary", "(no title)")
        st = ev.get("start", {})
        when = st.get("dateTime") or st.get("date") or "?"
        print(f"- id={eid}\n  when: {when}\n  {summ}\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--auth", action="store_true", help="Force new OAuth login (delete saved token)")
    parser.add_argument("--max", type=int, default=5, help="How many messages")
    parser.add_argument(
        "--calendar-check",
        action="store_true",
        help="After listing mail (if any), also print upcoming Calendar events.",
    )
    parser.add_argument(
        "--calendar-only",
        action="store_true",
        help="Only print upcoming Calendar events (no Gmail list).",
    )
    args = parser.parse_args()

    if args.auth and TOKEN_FILE.is_file():
        TOKEN_FILE.unlink()

    if not TOKEN_FILE.is_file() and not args.auth:
        print("No token yet. Run with --auth first.", file=sys.stderr)
        sys.exit(2)

    creds = get_creds()

    if args.calendar_only:
        _list_upcoming_events(creds, n=max(5, args.max))
        return

    service = build("gmail", "v1", credentials=creds)
    resp = (
        service.users()
        .messages()
        .list(userId="me", maxResults=args.max)
        .execute()
    )
    messages = resp.get("messages") or []
    if not messages:
        print("No messages returned (inbox may be empty or query has no results).")
        return

    print(f"Fetched {len(messages)} message(s):\n")
    for m in messages:
        mid = m["id"]
        full = (
            service.users()
            .messages()
            .get(userId="me", id=mid, format="metadata", metadataHeaders=["Subject", "From"])
            .execute()
        )
        headers = {h["name"]: h["value"] for h in full.get("payload", {}).get("headers", [])}
        subj = headers.get("Subject", "(no subject)")
        frm = headers.get("From", "?")
        print(f"- id={mid}\n  From: {frm}\n  Subject: {subj}\n")

    if args.calendar_check:
        print()
        _list_upcoming_events(creds, n=max(5, args.max))


if __name__ == "__main__":
    main()
