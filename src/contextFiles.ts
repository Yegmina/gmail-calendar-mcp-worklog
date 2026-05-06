import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const SOUL_BASENAME = "soul.md";
export const MEMORY_BASENAME = "memory.md";

export function soulPath(repoRoot: string): string {
  return resolve(repoRoot, "data", SOUL_BASENAME);
}

export function memoryPath(repoRoot: string): string {
  return resolve(repoRoot, "data", MEMORY_BASENAME);
}

export async function readSoulAndMemory(repoRoot: string): Promise<{ soul: string; memory: string }> {
  const soul = await readMarkdownQuiet(soulPath(repoRoot));
  const memory = await readMarkdownQuiet(memoryPath(repoRoot));
  return { soul, memory };
}

async function readMarkdownQuiet(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return "";
  }
}

/** Bounded append for memory.md (used by bot, not the LLM directly). */
export async function appendToMemoryFile(path: string, lines: string[], maxBytes: number = 48_000): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const stamp = new Date().toISOString();
  const block = lines.map((line) => `- [${stamp}] ${line}`).join("\n");
  let prev = "";
  try {
    prev = await readFile(path, "utf8");
  } catch {
    prev = "";
  }
  const next = `${prev.trim()}\n\n${block}\n`.trim() + "\n";
  const trimmed = next.length > maxBytes ? shrinkFromStart(next, maxBytes) : next;
  await writeFile(path, trimmed, "utf8");
}

/** Replace or create soul.md content when applying soul patches. */
export async function writeSoulFile(path: string, content: string, maxBytes: number = 16_000): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const trimmed = content.trim();
  const body = trimmed.length > maxBytes ? trimmed.slice(-maxBytes) : trimmed;
  await writeFile(path, `${body}\n`, "utf8");
}

function shrinkFromStart(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let start = Math.floor(text.length * 0.15);
  while (start < text.length && Buffer.byteLength(text.slice(start), "utf8") > maxBytes) {
    start += Math.floor((text.length - start) * 0.1);
  }
  return `# …truncated older memory…\n\n${text.slice(start).trim()}\n`;
}
