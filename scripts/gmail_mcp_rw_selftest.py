#!/usr/bin/env python3
"""Exercise Gmail + Calendar read/write using the same token as gmail-local MCP.

- Calendar: list calendars, list events, create a short test event, delete it.
- Gmail: list labels, search threads, create a self-draft, delete the draft.

Run from repo (or ~/.cursor/scripts) with venv Python:
  ~/.cursor/gmail-venv/bin/python scripts/gmail_mcp_rw_selftest.py
"""
from __future__ import annotations

import base64
import sys
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from googleapiclient.discovery import build

from google_personal_oauth import credentials_for_mcp


def main() -> None:
    print("== gmail-local style read/write self-test (same OAuth as MCP) ==\n")
    creds = credentials_for_mcp()

    # --- Calendar ---
    cal = build("calendar", "v3", credentials=creds)
    cl = cal.calendarList().list(maxResults=5).execute()
    items = cl.get("items") or []
    print(f"Calendar read: {len(items)} calendar(s) in first 5")
    for it in items[:3]:
        print(f"  - {it.get('summary')} (id={it.get('id')!r}…)")

    now = datetime.now(timezone.utc)
    tmin = now.isoformat().replace("+00:00", "Z")
    tmax = (now + timedelta(days=7)).isoformat().replace("+00:00", "Z")
    evlist = (
        cal.events()
        .list(
            calendarId="primary",
            timeMin=tmin,
            timeMax=tmax,
            maxResults=5,
            singleEvents=True,
            orderBy="startTime",
        )
        .execute()
    )
    evs = evlist.get("items") or []
    print(f"\nCalendar read: {len(evs)} event(s) next 7 days (primary, max 5)")

    # Tomorrow ~1h from now, rounded to whole minutes for stable API bodies
    start_dt = now + timedelta(days=1, hours=1)
    start_dt = start_dt.replace(minute=0, second=0, microsecond=0)
    end_dt = start_dt + timedelta(minutes=30)
    start_s = start_dt.isoformat()
    end_s = end_dt.isoformat()
    body = {
        "summary": "[MCP self-test] temporary event — safe to delete if left behind",
        "start": {"dateTime": start_s, "timeZone": "UTC"},
        "end": {"dateTime": end_s, "timeZone": "UTC"},
        "description": "Created by gmail_mcp_rw_selftest.py",
    }
    created = cal.events().insert(calendarId="primary", body=body).execute()
    eid = created.get("id")
    print(f"\nCalendar write: created event id={eid}")
    cal.events().delete(calendarId="primary", eventId=eid).execute()
    print(f"Calendar write: deleted event id={eid}")

    # --- Gmail ---
    gm = build("gmail", "v1", credentials=creds)
    labels = gm.users().labels().list(userId="me").execute().get("labels") or []
    print(f"\nGmail read: {len(labels)} labels")
    threads = gm.users().threads().list(userId="me", maxResults=3).execute().get("threads") or []
    print(f"Gmail read: {len(threads)} recent thread(s)")

    prof = gm.users().getProfile(userId="me").execute()
    me_addr = prof.get("emailAddress", "")
    if not me_addr:
        print("Gmail write: skip draft (no email on profile)", file=sys.stderr)
        return

    msg = MIMEText("MCP self-test draft — not sent.")
    msg["To"] = me_addr
    msg["Subject"] = "[MCP self-test] draft"
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    draft_body = {"message": {"raw": raw}}
    draft = gm.users().drafts().create(userId="me", body=draft_body).execute()
    did = draft.get("id")
    print(f"\nGmail write: created draft id={did}")
    gm.users().drafts().delete(userId="me", id=did).execute()
    print(f"Gmail write: deleted draft id={did}")

    print("\n== all checks OK ==")


if __name__ == "__main__":
    main()
