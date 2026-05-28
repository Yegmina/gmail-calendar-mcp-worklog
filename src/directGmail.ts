import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";

const execFileAsync = promisify(execFile);

type RecentEmail = {
  from: string;
  subject: string;
};

export function isDirectEmailCheck(text: string): boolean {
  if (needsAgentEmailReasoning(text)) return false;
  const asksForMail = /\b(email|emails|gmail|inbox|mail)\b/i.test(text);
  const asksForRecent = /\b(check|show|list|read)\b/i.test(text) && /\b(latest|recent|newest)\b/i.test(text);
  return (/\b(check|show|list|read)\b/i.test(text) && asksForMail) || asksForRecent;
}

export function requestedEmailCount(text: string, fallback = 5): number {
  const match = text.match(/\b(100|[1-9][0-9]?)\b/);
  if (!match) return fallback;
  return Math.min(Number(match[1]), 100);
}

export async function listRecentEmails(config: AppConfig, max = 5): Promise<string> {
  const script = join(dirname(config.gmailMcpServerScript), "gmail_list_recent.py");
  const { stdout, stderr } = await execFileAsync(config.gmailMcpPython, [script, "--max", String(max)], {
    cwd: config.repoRoot,
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
  });

  const emails = parseRecentEmails(stdout);
  if (emails.length === 0) {
    const detail = (stdout || stderr).trim();
    return detail || "No recent emails returned.";
  }

  return [`Recent emails (${emails.length}):`, ...emails.map((email, index) => `${index + 1}. ${email.from} — ${email.subject}`)].join(
    "\n",
  );
}

function parseRecentEmails(output: string): RecentEmail[] {
  const emails: RecentEmail[] = [];
  let from = "";
  let subject = "";

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- id=")) {
      if (from || subject) emails.push({ from: from || "?", subject: subject || "(no subject)" });
      from = "";
      subject = "";
      continue;
    }
    if (trimmed.startsWith("From: ")) from = trimmed.slice("From: ".length).trim();
    if (trimmed.startsWith("Subject: ")) subject = trimmed.slice("Subject: ".length).trim();
  }

  if (from || subject) emails.push({ from: from || "?", subject: subject || "(no subject)" });
  return emails;
}

function needsAgentEmailReasoning(text: string): boolean {
  return /\b(event|events|calendar|upcoming|add|adding|invite|invitation|registration|deadline|summari[sz]e|think|analy[sz]e|decide|important|action)\b/i.test(text);
}
