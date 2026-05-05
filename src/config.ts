import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type AppConfig = {
  cursorApiKey: string;
  requestedModelId: string;
  botToken?: string;
  openAiApiKey?: string;
  voiceTranscriptionModel: string;
  defaultTimezone: string;
  defaultCalendarId: string;
  allowedTelegramUserIds: Set<number>;
  notificationChatIds: Set<number>;
  emailMonitorEnabled: boolean;
  emailMonitorIntervalMinutes: number;
  emailMonitorLookbackHours: number;
  emailMonitorStatePath: string;
  repoRoot: string;
  gmailMcpPython: string;
  gmailMcpServerScript: string;
  telegramNode: string;
  telegramMcpScript: string;
  tgAppId?: string;
  tgApiHash?: string;
  tgSessionPath?: string;
};

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function requireEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseAllowedUserIds(raw: string | undefined): Set<number> {
  const values = (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const ids = new Set<number>();
  for (const value of values) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(`Invalid Telegram user id in ALLOWED_TELEGRAM_USER_IDS: ${value}`);
    }
    ids.add(parsed);
  }
  return ids;
}

function parseInteger(name: string, fallback: number, min: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return parsed;
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const raw = env(name);
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export function loadConfig(options: { requireBotToken?: boolean } = {}): AppConfig {
  const repoRoot = resolve(env("BOT_WORKDIR") ?? process.cwd());
  const config: AppConfig = {
    cursorApiKey: requireEnv("CURSOR_API_KEY"),
    requestedModelId: env("CURSOR_MODEL_ID") ?? "composer-2-fast",
    botToken: env("MANAGER4YEHOR_BOT_TOKEN"),
    openAiApiKey: env("OPENAI_API_KEY"),
    voiceTranscriptionModel: env("VOICE_TRANSCRIPTION_MODEL") ?? "gpt-4o-mini-transcribe",
    defaultTimezone: env("DEFAULT_TIMEZONE") ?? "Europe/Helsinki",
    defaultCalendarId: env("DEFAULT_CALENDAR_ID") ?? "primary",
    allowedTelegramUserIds: parseAllowedUserIds(env("ALLOWED_TELEGRAM_USER_IDS")),
    notificationChatIds: parseAllowedUserIds(env("TELEGRAM_NOTIFY_CHAT_IDS")),
    emailMonitorEnabled: parseBoolean("EMAIL_MONITOR_ENABLED", true),
    emailMonitorIntervalMinutes: parseInteger("EMAIL_MONITOR_INTERVAL_MINUTES", 60, 1),
    emailMonitorLookbackHours: parseInteger("EMAIL_MONITOR_LOOKBACK_HOURS", 2, 1),
    emailMonitorStatePath: resolve(env("EMAIL_MONITOR_STATE_PATH") ?? `${repoRoot}/data/email-monitor-state.json`),
    repoRoot,
    gmailMcpPython: env("GMAIL_MCP_PYTHON") ?? "/root/.cursor/gmail-venv/bin/python",
    gmailMcpServerScript: env("GMAIL_MCP_SERVER_SCRIPT") ?? "/root/.cursor/scripts/gmail_mcp_stdio_server.py",
    telegramNode: env("TELEGRAM_NODE") ?? "/usr/bin/node",
    telegramMcpScript: env("TELEGRAM_MCP_SCRIPT") ?? "/root/.cursor/telegram-mcp-cursor.js",
    tgAppId: env("TG_APP_ID"),
    tgApiHash: env("TG_API_HASH"),
    tgSessionPath: env("TG_SESSION_PATH"),
  };

  if (options.requireBotToken && !config.botToken) {
    throw new Error("Missing required environment variable: MANAGER4YEHOR_BOT_TOKEN");
  }

  assertPathExists(config.gmailMcpPython, "GMAIL_MCP_PYTHON");
  assertPathExists(config.gmailMcpServerScript, "GMAIL_MCP_SERVER_SCRIPT");
  assertPathExists(config.telegramNode, "TELEGRAM_NODE");
  assertPathExists(config.telegramMcpScript, "TELEGRAM_MCP_SCRIPT");

  return config;
}

function assertPathExists(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(`${label} path does not exist: ${path}`);
  }
}

export function isAllowedTelegramUser(config: AppConfig, userId: number | undefined): boolean {
  if (config.allowedTelegramUserIds.size === 0) return true;
  if (userId === undefined) return false;
  return config.allowedTelegramUserIds.has(userId);
}
