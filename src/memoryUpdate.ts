import type { AppConfig } from "./config.js";
import { appendToMemoryFile, memoryPath, readSoulAndMemory, soulPath, writeSoulFile } from "./contextFiles.js";
import { runPrompt } from "./agentRunner.js";
import { buildMemoryUpdatePrompt } from "./prompts.js";

const MAX_MEMORY_BULLETS = 8;
const MAX_MEMORY_LINE = 400;
const MAX_SOUL_BULLETS = 3;
const MAX_SOUL_LINE = 320;

export type MemoryUpdateInput = {
  userText: string;
  assistantText: string;
  chatContext: string;
  /** When true (e.g. /remember), bias toward memory_append only. */
  rememberOnly?: boolean;
};

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`memory update returned non-JSON: ${trimmed.slice(0, 200)}`);
  return match[0];
}

type MemoryUpdateJson = {
  memory_append?: unknown;
  soul_append?: unknown;
};

function normalizeBullets(raw: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const line = item.replace(/\s+/g, " ").trim();
    if (!line) continue;
    out.push(line.slice(0, maxLen));
    if (out.length >= maxItems) break;
  }
  return out;
}

export async function runMemoryUpdatePipeline(config: AppConfig, input: MemoryUpdateInput): Promise<void> {
  if (!config.memoryAgentUpdatesEnabled) return;

  const { soul, memory } = await readSoulAndMemory(config.repoRoot);
  const prompt = buildMemoryUpdatePrompt({
    userText: input.userText,
    assistantText: input.assistantText,
    chatContext: input.chatContext,
    currentSoul: soul || "(empty)",
    currentMemory: memory || "(empty)",
    rememberOnly: input.rememberOnly ?? false,
  });

  try {
    const result = await runPrompt(config, prompt);
    if (result.status !== "finished") {
      console.warn(`memory_update agent status=${result.status} run=${result.runId}`);
      return;
    }

    let parsed: MemoryUpdateJson;
    try {
      parsed = JSON.parse(extractJson(result.text)) as MemoryUpdateJson;
    } catch (error) {
      console.warn("memory_update parse_failed", error);
      return;
    }

    const memoryBullets = normalizeBullets(parsed.memory_append, MAX_MEMORY_BULLETS, MAX_MEMORY_LINE);
    let soulBullets = normalizeBullets(parsed.soul_append, MAX_SOUL_BULLETS, MAX_SOUL_LINE);
    if (input.rememberOnly) soulBullets = [];

    if (memoryBullets.length > 0) {
      await appendToMemoryFile(memoryPath(config.repoRoot), memoryBullets);
    }

    if (soulBullets.length > 0) {
      const soulP = soulPath(config.repoRoot);
      const base = soul.trim().length > 0 ? `${soul.trim()}\n\n` : "";
      await writeSoulFile(soulP, `${base}${soulBullets.map((line) => `- ${line}`).join("\n")}`);
    }

    if (memoryBullets.length > 0 || soulBullets.length > 0) {
      console.log(
        JSON.stringify({
          msg: "memory_files_updated",
          memoryLines: memoryBullets.length,
          soulLines: soulBullets.length,
        }),
      );
    }
  } catch (error) {
    console.warn("memory_update failed", error);
  }
}
