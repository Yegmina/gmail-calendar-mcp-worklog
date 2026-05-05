/** Escape text for Telegram HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Cursor models often emit GitHub-style **bold** and `inline code`.
 * Telegram HTML uses <b> and <code>; legacy Markdown uses *bold*, not **.
 */
export function modelOutputToTelegramHtml(text: string): string {
  const escaped = escapeHtml(text);
  let s = escaped.replace(/```([\s\S]*?)```/g, (_, code) => `<pre>${code.trim()}</pre>`);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, "<b>$1</b>");
  return s;
}

/** Split plain text so converted HTML stays under Telegram's ~4096 limit with margin. */
export function chunkPlainTextForTelegram(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n\n", maxLen);
    if (cut < maxLen / 2) cut = rest.lastIndexOf("\n", maxLen);
    if (cut < maxLen / 2) cut = rest.lastIndexOf(" ", maxLen);
    if (cut < maxLen / 2) cut = maxLen;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
