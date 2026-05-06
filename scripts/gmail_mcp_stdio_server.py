#!/usr/bin/env python3
"""Gmail + Google Calendar + Google Tasks MCP (stdio) for remote/SSH Cursor — uses token on *this* machine.

Uses the same OAuth files as gmail_list_recent.py (Desktop client, paste redirect once).

One-time on *this* host:
  GCP: enable Gmail API + Google Calendar API + Google Tasks API for project gmail-mcp-personal-495219.
  ~/.cursor/gmail-venv/bin/python ~/.cursor/scripts/gmail_list_recent.py --auth

Scopes: gmail.modify + calendar + tasks (see google_personal_oauth.SCOPES).

Then enable mcpServers.gmail-local in ~/.cursor/mcp.json and reload Cursor.

Does not touch studyshortspayservice.
"""
from __future__ import annotations

import base64
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from googleapiclient.discovery import build
from mcp.server.fastmcp import FastMCP

from google_personal_oauth import credentials_for_mcp

mcp = FastMCP("gmail-local (Gmail + Calendar + Tasks)")


def _creds():
    return credentials_for_mcp()


def _gmail():
    return build("gmail", "v1", credentials=_creds())


def _calendar():
    return build("calendar", "v3", credentials=_creds())


def _tasks():
    return build("tasks", "v1", credentials=_creds())


def _parse_iso(dt: str) -> datetime:
    s = dt.strip().replace("Z", "+00:00")
    return datetime.fromisoformat(s)


def _b64url_decode(data: str) -> str:
    if not data:
        return ""
    padded = data + "=" * (-len(data) % 4)
    try:
        raw = base64.urlsafe_b64decode(padded)
        return raw.decode("utf-8", errors="replace")
    except Exception:
        return ""


def _iter_payload_parts(payload: dict | None) -> list[dict]:
    if not payload:
        return []
    nested = payload.get("parts")
    if nested:
        out: list[dict] = []
        for p in nested:
            out.extend(_iter_payload_parts(p))
        return out
    return [payload]


def _split_plain_and_html_from_parts(parts: list[dict]) -> tuple[list[str], list[str]]:
    plain_chunks: list[str] = []
    html_chunks: list[str] = []
    for part in parts:
        mime = (part.get("mimeType") or "").lower()
        body = part.get("body") or {}
        bdata = body.get("data")
        if not bdata:
            continue
        text = _b64url_decode(str(bdata))
        if mime == "text/plain":
            plain_chunks.append(text)
        elif mime == "text/html":
            html_chunks.append(text)
    return plain_chunks, html_chunks


def _format_attachment_lines(parts: list[dict]) -> list[str]:
    lines: list[str] = []
    for part in parts:
        body = part.get("body") or {}
        att_id = body.get("attachmentId")
        if not att_id:
            continue
        fname = part.get("filename") or "(no filename)"
        mime = part.get("mimeType") or "?"
        size = body.get("size") if body.get("size") is not None else "?"
        lines.append(f"  - {fname}\tmime={mime}\tsize={size}\tattachmentId={att_id}")
    return lines


def _clamp_max_body_chars(n: int) -> int:
    return max(4_096, min(int(n), 400_000))


def _truncate_text(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n\n… [truncated]"


def _normalize_task_due(due: str) -> str | None:
    """Accept YYYY-MM-DD or full RFC3339; Tasks API expects RFC3339."""
    s = due.strip()
    if not s:
        return None
    if len(s) == 10 and s[4] == "-" and s[7] == "-":
        return f"{s}T00:00:00.000Z"
    return s


def _trunc_notes(notes: str, max_len: int = 200) -> str:
    n = notes.replace("\r\n", "\n").replace("\r", "\n").strip()
    if len(n) <= max_len:
        return n
    return n[:max_len] + "…"


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
def get_message_body(message_id: str, max_body_chars: int = 150_000) -> str:
    """Fetch one Gmail message by id: headers, decoded body (text/plain preferred, else text/html), and attachment metadata (no file bytes). Use message_id from get_thread."""
    try:
        mid = message_id.strip()
        if not mid:
            return "Error: message_id required"
        limit = _clamp_max_body_chars(max_body_chars)
        svc = _gmail()
        msg = svc.users().messages().get(userId="me", id=mid, format="full").execute()
        payload = msg.get("payload") or {}
        header_list = payload.get("headers") or []
        hdr = {h["name"]: h["value"] for h in header_list if isinstance(h, dict) and "name" in h}
        parts = _iter_payload_parts(payload)
        plain_chunks, html_chunks = _split_plain_and_html_from_parts(parts)
        plain = "\n\n".join(plain_chunks).strip()
        html = "\n\n".join(html_chunks).strip()

        if plain:
            body_text = plain
        elif html:
            body_text = "(Only HTML body available; raw tags follow.)\n\n" + html
        else:
            snippet = (msg.get("snippet") or "").strip()
            body_text = "(no text/plain or text/html body decoded)\nSnippet: " + (snippet or "(empty)")

        body_out = _truncate_text(body_text, limit)

        head_lines = [f"message_id={mid}"]
        for key in ("Subject", "From", "To", "Cc", "Date"):
            if key in hdr:
                head_lines.append(f"{key}: {hdr[key]}")

        att = _format_attachment_lines(parts)
        att_block = "\n".join(att) if att else "  (none)"

        return (
            "\n".join(head_lines)
            + "\n\n--- Body ---\n"
            + body_out
            + "\n\n--- Attachments ---\n"
            + att_block
        )
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


@mcp.tool()
def list_tasklists(max_results: int = 30) -> str:
    """List Google Task lists (id + title). Use @default for the default list in other task tools."""
    try:
        svc = _tasks()
        max_results = max(1, min(int(max_results), 100))
        resp = svc.tasklists().list(maxResults=max_results).execute()
        items = resp.get("items") or []
        if not items:
            return "(no task lists)"
        lines = []
        for it in items:
            lines.append(f"id={it.get('id')}\ttitle={it.get('title', '')}")
        return "\n".join(lines)
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def list_tasks(
    tasklist_id: str = "@default",
    show_completed: bool = True,
    show_hidden: bool = False,
    max_results: int = 50,
) -> str:
    """List tasks in a task list. Returns task_id, title, status, due, notes (truncated)."""
    try:
        svc = _tasks()
        tlist = tasklist_id.strip() or "@default"
        max_results = max(1, min(int(max_results), 100))
        resp = (
            svc.tasks()
            .list(
                tasklist=tlist,
                showCompleted=bool(show_completed),
                showHidden=bool(show_hidden),
                maxResults=max_results,
            )
            .execute()
        )
        tasks = resp.get("items") or []
        if not tasks:
            return "(no tasks in list)"
        lines = []
        for t in tasks:
            tid = t.get("id", "?")
            title = (t.get("title") or "").replace("\t", " ")
            status = t.get("status") or "?"
            due = t.get("due") or ""
            notes_raw = t.get("notes") or ""
            notes = _trunc_notes(str(notes_raw), 200)
            lines.append(f"task_id={tid}\tstatus={status}\tdue={due}\ttitle={title}\tnotes={notes}")
        return "\n".join(lines)
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def create_task(
    title: str,
    tasklist_id: str = "@default",
    notes: str = "",
    due: str = "",
) -> str:
    """Create a Google Task. due: YYYY-MM-DD or RFC3339; empty = no due date."""
    try:
        if not title.strip():
            return "Error: title required"
        svc = _tasks()
        tlist = tasklist_id.strip() or "@default"
        body: dict = {"title": title.strip()}
        if notes.strip():
            body["notes"] = notes.strip()
        due_n = _normalize_task_due(due)
        if due_n:
            body["due"] = due_n
        created = svc.tasks().insert(tasklist=tlist, body=body).execute()
        return f"created task_id={created.get('id')} tasklist={tlist} title={created.get('title', '')}"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def update_task(
    task_id: str,
    tasklist_id: str = "@default",
    title: str = "",
    notes: str = "",
    due: str = "",
    status: str = "",
) -> str:
    """Patch a Google Task. status: needsAction or completed. due: use __clear__ to remove due date. Omit fields you do not change (pass empty string)."""
    try:
        tid = task_id.strip()
        if not tid:
            return "Error: task_id required"
        tlist = tasklist_id.strip() or "@default"
        body: dict = {}
        if title.strip():
            body["title"] = title.strip()
        if notes.strip():
            body["notes"] = notes.strip()
        d = due.strip()
        if d == "__clear__":
            body["due"] = None
        elif d:
            due_n = _normalize_task_due(due)
            if due_n:
                body["due"] = due_n
        st = status.strip().lower()
        if st in ("needsaction", "needs_action"):
            body["status"] = "needsAction"
        elif st == "completed":
            body["status"] = "completed"
        elif status.strip():
            return f"Error: status must be needsAction or completed, got {status!r}"

        if not body:
            return "Error: provide at least one of title, notes, due, status (non-empty)"

        svc = _tasks()
        updated = svc.tasks().patch(tasklist=tlist, task=tid, body=body).execute()
        return (
            f"updated task_id={updated.get('id')} status={updated.get('status')} "
            f"due={updated.get('due') or ''} title={updated.get('title', '')}"
        )
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def delete_task(task_id: str, tasklist_id: str = "@default") -> str:
    """Delete a task by id (from list_tasks)."""
    try:
        tid = task_id.strip()
        if not tid:
            return "Error: task_id required"
        tlist = tasklist_id.strip() or "@default"
        svc = _tasks()
        svc.tasks().delete(tasklist=tlist, task=tid).execute()
        return f"deleted task_id={tid} tasklist={tlist}"
    except Exception as e:
        return f"Error: {e}"


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
