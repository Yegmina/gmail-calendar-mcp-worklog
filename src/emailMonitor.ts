import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Telegraf } from "telegraf";
import type { AppConfig } from "./config.js";
import { createLocalAgent, runPromptWithAgent } from "./agentRunner.js";
import { buildEmailMonitorPrompt } from "./prompts.js";
import { chunkPlainTextForTelegram, modelOutputToTelegramHtml } from "./telegramFormat.js";

const MAX_SEEN_THREADS = 500;
const TELEGRAM_CHUNK = 3500;

type EmailMonitorState = {
  seenThreadIds: string[];
  notificationChatIds?: number[];
  lastCheckedAt?: string;
};

type MonitorJson = {
  seenThreadIds?: unknown;
  alerts?: unknown;
};

type TelegramApi = Telegraf["telegram"];

export function startEmailMonitor(bot: Telegraf, config: AppConfig): void {
  if (!config.emailMonitorEnabled) {
    console.log("Email monitor disabled.");
    return;
  }

  if (notificationChatIds(config, { seenThreadIds: [] }).length === 0) {
    console.warn("Email monitor has no notify chat yet; message the bot once or set TELEGRAM_NOTIFY_CHAT_IDS.");
  }

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await checkEmailOnce(bot.telegram, config);
    } catch (error) {
      console.error("Email monitor failed:", error);
    } finally {
      running = false;
    }
  };

  setTimeout(run, 30_000);
  setInterval(run, config.emailMonitorIntervalMinutes * 60_000);
  console.log(`Email monitor running every ${config.emailMonitorIntervalMinutes} minute(s).`);
}

export async function rememberNotificationChatId(config: AppConfig, chatId: number): Promise<void> {
  const state = await readState(config.emailMonitorStatePath);
  const ids = new Set([...(state.notificationChatIds ?? []), chatId]);
  await writeState(config.emailMonitorStatePath, {
    ...state,
    notificationChatIds: [...ids],
  });
}

function notificationChatIds(config: AppConfig, state: EmailMonitorState): number[] {
  const ids = new Set<number>();
  for (const id of config.notificationChatIds) ids.add(id);
  for (const id of state.notificationChatIds ?? []) ids.add(id);
  for (const id of config.allowedTelegramUserIds) ids.add(id);
  return [...ids];
}

async function checkEmailOnce(telegram: TelegramApi, config: AppConfig): Promise<void> {
  const state = await readState(config.emailMonitorStatePath);
  const chatIds = notificationChatIds(config, state);
  if (chatIds.length === 0) return;

  const agent = await createLocalAgent(config);
  try {
    const prompt = buildEmailMonitorPrompt({
      knownThreadIds: state.seenThreadIds,
      lookbackHours: config.emailMonitorLookbackHours,
      defaultTimezone: config.defaultTimezone,
      defaultCalendarId: config.defaultCalendarId,
    });
    const result = await runPromptWithAgent(agent, prompt);
    if (result.status !== "finished") {
      console.warn(`Email monitor agent ended with status ${result.status}. run=${result.runId}`);
      return;
    }

    const parsed = parseMonitorJson(result.text);
    const nextSeen = mergeSeenThreadIds(state.seenThreadIds, parsed.seenThreadIds);
    await writeState(config.emailMonitorStatePath, {
      seenThreadIds: nextSeen,
      lastCheckedAt: new Date().toISOString(),
    });

    const alerts = parsed.alerts.map((alert) => alert.trim()).filter(Boolean);
    if (result.calendarUpdates.length > 0 && !alerts.some((alert) => /calendar|event/i.test(alert))) {
      alerts.unshift("Calendar updated from email.");
    }
    if (alerts.length === 0) return;

    const text = alerts.join("\n");
    for (const chatId of chatIds) {
      await sendTelegramHtml(telegram, chatId, text);
    }
  } finally {
    await agent[Symbol.asyncDispose]();
  }
}

async function readState(path: string): Promise<EmailMonitorState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<EmailMonitorState>;
    return {
      seenThreadIds: Array.isArray(parsed.seenThreadIds) ? parsed.seenThreadIds.filter(isString) : [],
      notificationChatIds: Array.isArray(parsed.notificationChatIds) ? parsed.notificationChatIds.filter(isNumber) : [],
      lastCheckedAt: parsed.lastCheckedAt,
    };
  } catch {
    return { seenThreadIds: [] };
  }
}

async function writeState(path: string, state: EmailMonitorState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

function parseMonitorJson(text: string): { seenThreadIds: string[]; alerts: string[] } {
  const jsonText = extractJson(text);
  const parsed = JSON.parse(jsonText) as MonitorJson;
  return {
    seenThreadIds: Array.isArray(parsed.seenThreadIds) ? parsed.seenThreadIds.filter(isString) : [],
    alerts: Array.isArray(parsed.alerts) ? parsed.alerts.filter(isString) : [],
  };
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Email monitor returned non-JSON: ${trimmed.slice(0, 200)}`);
  return match[0];
}

function mergeSeenThreadIds(existing: string[], incoming: string[]): string[] {
  const seen = new Set<string>();
  const combined = [...incoming, ...existing].filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return combined.slice(0, MAX_SEEN_THREADS);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNumber(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

async function sendTelegramHtml(telegram: TelegramApi, chatId: number, text: string): Promise<void> {
  for (const piece of chunkPlainTextForTelegram(text, TELEGRAM_CHUNK)) {
    const html = modelOutputToTelegramHtml(piece);
    try {
      await telegram.sendMessage(chatId, html, { parse_mode: "HTML" });
    } catch {
      await telegram.sendMessage(chatId, piece);
    }
  }
}
