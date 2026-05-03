#!/usr/bin/env python3
"""Gmail + Google Calendar MCP (stdio) for remote/SSH Cursor — uses token on *this* machine.

Uses the same OAuth files as gmail_list_recent.py (Desktop client, paste redirect once).

One-time on *this* host:
  GCP: enable Google Calendar API for project gmail-mcp-personal-495219.
  ~/.cursor/gmail-venv/bin/python ~/.cursor/scripts/gmail_list_recent.py --auth

Scopes: gmail.modify + calendar (see google_personal_oauth.SCOPES).

Then enable mcpServers.gmail-local in ~/.cursor/mcp.json and reload Cursor.

Does not touch studyshortspayservice.
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from googleapiclient.discovery import build
from mcp.server.fastmcp import FastMCP

from google_personal_oauth import credentials_for_mcp

mcp = FastMCP("gmail-local (Gmail + Calendar)")


def _creds():
    return credentials_for_mcp()


def _gmail():
    return build("gmail", "v1", credentials=_creds())


def _calendar():
    return build("calendar", "v3", credentials=_creds())


def _parse_iso(dt: str) -> datetime:
    s = dt.strip().replace("Z", "+00:00")
    return datetime.fromisoformat(s)


@mcp.tool()
def list_labels(page_size: int = 50) -> str:
    """List Gmail labels (user-defined and system)."""
    try:
        svc = _gmail()
        page_size = max(1, min(int(page_size), 200))
        resp = svc.users().labels().list(userId="me").execute()
        labels = resp.get("labels") or []
        lines = [f"{lb.get('id')}\t{lb.get('name')}" for lb in labels[:page_size]]
        return "\n".join(lines) if lines else "(no labels)"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def search_threads(query: str = "", page_size: int = 20) -> str:
    """Search Gmail threads (Gmail query syntax). Empty query lists recent threads."""
    try:
        svc = _gmail()
        page_size = max(1, min(int(page_size), 50))
        kwargs = {"userId": "me", "maxResults": page_size}
        if query.strip():
            kwargs["q"] = query.strip()
        resp = svc.users().threads().list(**kwargs).execute()
        threads = resp.get("threads") or []
        if not threads:
            return "(no threads)"
        out = []
        for t in threads:
            tid = t.get("id")
            detail = (
                svc.users()
                .threads()
                .get(userId="me", id=tid, format="metadata", metadataHeaders=["Subject", "From"])
                .execute()
            )
            msgs = detail.get("messages") or []
            subj = frm = "?"
            if msgs:
                headers = {h["name"]: h["value"] for h in msgs[0].get("payload", {}).get("headers", [])}
                subj = headers.get("Subject", "?")
                frm = headers.get("From", "?")
            snip = (msgs[0].get("snippet") if msgs else "") or ""
            out.append(f"id={tid}\n  From: {frm}\n  Subject: {subj}\n  Snippet: {snip[:200]}")
        return "\n\n".join(out)
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def get_thread(thread_id: str) -> str:
    """Fetch one thread by id (subject, from, snippet per message)."""
    try:
        if not thread_id.strip():
            return "Error: thread_id required"
        svc = _gmail()
        detail = svc.users().threads().get(userId="me", id=thread_id.strip(), format="full").execute()
        msgs = detail.get("messages") or []
        parts = []
        for msg in msgs:
            hid = msg.get("id", "?")
            headers = {h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])}
            subj = headers.get("Subject", "?")
            frm = headers.get("From", "?")
            snip = msg.get("snippet") or ""
            parts.append(f"message_id={hid}\n  From: {frm}\n  Subject: {subj}\n  Snippet: {snip[:500]}")
        return "\n\n".join(parts) if parts else "(empty thread)"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def list_calendars(max_results: int = 30) -> str:
    """List calendars you can access (id + summary). Use 'primary' for your main calendar."""
    try:
        svc = _calendar()
        max_results = max(1, min(int(max_results), 100))
        resp = svc.calendarList().list(maxResults=max_results).execute()
        items = resp.get("items") or []
        if not items:
            return "(no calendars)"
        lines = []
        for it in items:
            lines.append(f"id={it.get('id')}\tsummary={it.get('summary')}\tprimary={it.get('primary', False)}")
        return "\n".join(lines)
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def list_events(
    calendar_id: str = "primary",
    time_min_iso: str = "",
    time_max_iso: str = "",
    max_results: int = 50,
) -> str:
    """List events in a time window (RFC3339 e.g. 2026-05-03T10:00:00+03:00 or Z). Empty min/max = now .. +30 days."""
    try:
        svc = _calendar()
        max_results = max(1, min(int(max_results), 250))
        now = datetime.now(timezone.utc)
        if not time_min_iso.strip():
            time_min = now.isoformat().replace("+00:00", "Z")
        else:
            time_min = _parse_iso(time_min_iso).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        if not time_max_iso.strip():
            end = now + timedelta(days=30)
            time_max = end.isoformat().replace("+00:00", "Z")
        else:
            time_max = _parse_iso(time_max_iso).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        resp = (
            svc.events()
            .list(
                calendarId=calendar_id.strip() or "primary",
                timeMin=time_min,
                timeMax=time_max,
                maxResults=max_results,
                singleEvents=True,
                orderBy="startTime",
            )
            .execute()
        )
        events = resp.get("items") or []
        if not events:
            return "(no events in range)"
        lines = []
        for ev in events:
            eid = ev.get("id", "?")
            summ = ev.get("summary", "(no title)")
            loc = ev.get("location") or ""
            start = ev.get("start", {})
            st = start.get("dateTime") or start.get("date") or "?"
            lines.append(f"event_id={eid}\tstart={st}\tsummary={summ}\tlocation={loc}")
        return "\n".join(lines)
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def create_event(
    summary: str,
    start_datetime_iso: str,
    calendar_id: str = "primary",
    end_datetime_iso: str = "",
    description: str = "",
    location: str = "",
    timezone: str = "UTC",
) -> str:
    """Create a calendar event. Times are RFC3339. If end_datetime_iso is empty, end = start + 1 hour."""
    try:
        if not summary.strip():
            return "Error: summary required"
        if not start_datetime_iso.strip():
            return "Error: start_datetime_iso required"
        svc = _calendar()
        start_s = start_datetime_iso.strip()
        if end_datetime_iso.strip():
            end_s = end_datetime_iso.strip()
        else:
            st = _parse_iso(start_s)
            end_s = (st + timedelta(hours=1)).isoformat()
        body: dict = {
            "summary": summary.strip(),
            "start": {"dateTime": start_s, "timeZone": timezone.strip() or "UTC"},
            "end": {"dateTime": end_s, "timeZone": timezone.strip() or "UTC"},
        }
        if description.strip():
            body["description"] = description.strip()
        if location.strip():
            body["location"] = location.strip()
        ev = svc.events().insert(calendarId=(calendar_id.strip() or "primary"), body=body).execute()
        return f"created event_id={ev.get('id')} htmlLink={ev.get('htmlLink', '')}"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def delete_event(event_id: str, calendar_id: str = "primary") -> str:
    """Delete an event by id (from list_events)."""
    try:
        if not event_id.strip():
            return "Error: event_id required"
        svc = _calendar()
        svc.events().delete(calendarId=(calendar_id.strip() or "primary"), eventId=event_id.strip()).execute()
        return f"deleted event_id={event_id.strip()}"
    except Exception as e:
        return f"Error: {e}"


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
