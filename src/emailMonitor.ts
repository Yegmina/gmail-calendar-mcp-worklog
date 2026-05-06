import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Telegraf } from "telegraf";
import type { AppConfig } from "./config.js";
import { createLocalAgent, runPromptWithAgent } from "./agentRunner.js";
import { buildEmailMonitorPrompt } from "./prompts.js";
import { chunkPlainTextForTelegram, modelOutputToTelegramHtml } from "./telegramFormat.js";

const MAX_WATERMARK_THREADS = 500;
const TELEGRAM_CHUNK = 3500;

export type EmailMonitorState = {
  /** Gmail thread id -> last processed message id (newest in thread at time of processing). */
  threadWatermarks: Record<string, string>;
  notificationChatIds?: number[];
  lastCheckedAt?: string;
};

type MonitorJson = {
  threadWatermarks?: unknown;
  alerts?: unknown;
};

type TelegramApi = Telegraf["telegram"];

const emptyMonitorState = (): EmailMonitorState => ({ threadWatermarks: {} });

export function startEmailMonitor(bot: Telegraf, config: AppConfig): void {
  if (!config.emailMonitorEnabled) {
    console.log(JSON.stringify({ msg: "email_monitor", enabled: false }));
    return;
  }

  if (notificationChatIds(config, emptyMonitorState()).length === 0) {
    console.warn(
      "Email monitor has no notify chat yet; message the bot once (/start or any message) or set TELEGRAM_NOTIFY_CHAT_IDS.",
    );
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
  console.log(
    JSON.stringify({
      msg: "email_monitor_started",
      intervalMinutes: config.emailMonitorIntervalMinutes,
      lookbackHours: config.emailMonitorLookbackHours,
    }),
  );
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
  const t0 = Date.now();
  const state = await readState(config.emailMonitorStatePath);
  const chatIds = notificationChatIds(config, state);
  if (chatIds.length === 0) {
    console.log(JSON.stringify({ msg: "email_monitor_skip", reason: "no_notify_chats" }));
    return;
  }

  const agent = await createLocalAgent(config);
  try {
    const prompt = buildEmailMonitorPrompt({
      threadWatermarks: state.threadWatermarks,
      lookbackHours: config.emailMonitorLookbackHours,
      defaultTimezone: config.defaultTimezone,
      defaultCalendarId: config.defaultCalendarId,
    });
    const result = await runPromptWithAgent(agent, prompt);
    if (result.status !== "finished") {
      console.warn(
        JSON.stringify({
          msg: "email_monitor_agent_not_finished",
          status: result.status,
          runId: result.runId,
          chatIds: chatIds.length,
          durationMs: Date.now() - t0,
        }),
      );
      return;
    }

    let parsed: ReturnType<typeof parseMonitorJson>;
    try {
      parsed = parseMonitorJson(result.text);
    } catch (error) {
      console.warn(
        JSON.stringify({
          msg: "email_monitor_json_parse_failed",
          error: error instanceof Error ? error.message : String(error),
          runId: result.runId,
          durationMs: Date.now() - t0,
        }),
      );
      return;
    }

    const nextWatermarks = mergeThreadWatermarks(state.threadWatermarks, parsed.threadWatermarks);
    await writeState(config.emailMonitorStatePath, {
      ...state,
      threadWatermarks: nextWatermarks,
      lastCheckedAt: new Date().toISOString(),
    });

    const alerts = parsed.alerts.map((alert) => alert.trim()).filter(Boolean);
    if (result.calendarUpdates.length > 0 && !alerts.some((alert) => /calendar|event/i.test(alert))) {
      alerts.unshift("Calendar updated from email.");
    }

    console.log(
      JSON.stringify({
        msg: "email_monitor_cycle",
        chatIds: chatIds.length,
        runId: result.runId,
        status: result.status,
        alertCount: alerts.length,
        watermarkCount: Object.keys(nextWatermarks).length,
        durationMs: Date.now() - t0,
      }),
    );

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
    const parsed = JSON.parse(raw) as Partial<EmailMonitorState> & { seenThreadIds?: unknown };
    const hasWatermarksKey = Object.prototype.hasOwnProperty.call(parsed, "threadWatermarks");
    let threadWatermarks = normalizeWatermarks(parsed.threadWatermarks);
    if (!hasWatermarksKey && Array.isArray(parsed.seenThreadIds) && parsed.seenThreadIds.some((x) => isString(x))) {
      console.log(
        JSON.stringify({
          msg: "email_monitor_migrated_legacy_seen_thread_ids",
          count: parsed.seenThreadIds.length,
        }),
      );
      threadWatermarks = {};
    }
    const notificationChatIds = Array.isArray(parsed.notificationChatIds)
      ? parsed.notificationChatIds.filter(isNumber)
      : undefined;
    return {
      threadWatermarks,
      notificationChatIds,
      lastCheckedAt: parsed.lastCheckedAt,
    };
  } catch {
    return emptyMonitorState();
  }
}

async function writeState(path: string, state: EmailMonitorState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const payload: EmailMonitorState = {
    threadWatermarks: capWatermarks(state.threadWatermarks, MAX_WATERMARK_THREADS),
    ...(state.notificationChatIds?.length ? { notificationChatIds: state.notificationChatIds } : {}),
    ...(state.lastCheckedAt ? { lastCheckedAt: state.lastCheckedAt } : {}),
  };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function normalizeWatermarks(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== "string" || typeof v !== "string") continue;
    const tid = k.trim();
    const mid = v.trim();
    if (!tid || !mid) continue;
    out[tid] = mid;
  }
  return out;
}

function mergeThreadWatermarks(
  existing: Record<string, string>,
  incoming: Record<string, string>,
): Record<string, string> {
  return capWatermarks({ ...existing, ...incoming }, MAX_WATERMARK_THREADS);
}

function capWatermarks(w: Record<string, string>, max: number): Record<string, string> {
  const keys = Object.keys(w);
  if (keys.length <= max) return { ...w };
  keys.sort();
  const drop = keys.length - max;
  const next = { ...w };
  for (let i = 0; i < drop; i++) delete next[keys[i]];
  return next;
}

function parseMonitorJson(text: string): { threadWatermarks: Record<string, string>; alerts: string[] } {
  const jsonText = extractJson(text);
  const parsed = JSON.parse(jsonText) as MonitorJson;
  return {
    threadWatermarks: normalizeWatermarks(parsed.threadWatermarks),
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
