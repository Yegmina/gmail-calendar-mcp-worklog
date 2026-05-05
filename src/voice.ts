import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import type { Context } from "telegraf";
import type { AppConfig } from "./config.js";

export async function transcribeTelegramVoice(ctx: Context, fileId: string, config: AppConfig): Promise<string> {
  if (!config.openAiApiKey) {
    throw new Error("Voice received, but OPENAI_API_KEY is not configured for transcription.");
  }

  const tmp = await mkdtemp(join(tmpdir(), "manager4yehor-voice-"));
  const audioPath = join(tmp, `${fileId}.oga`);
  try {
    const link = await ctx.telegram.getFileLink(fileId);
    const response = await fetch(link);
    if (!response.ok || !response.body) {
      throw new Error(`Telegram voice download failed: HTTP ${response.status}`);
    }
    await writeFile(audioPath, Buffer.from(await response.arrayBuffer()));

    const client = new OpenAI({ apiKey: config.openAiApiKey });
    const result = await client.audio.transcriptions.create({
      file: await OpenAI.toFile(await readFile(audioPath), "voice.oga"),
      model: config.voiceTranscriptionModel,
    });
    return result.text.trim();
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
