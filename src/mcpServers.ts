import type { McpServerConfig } from "@cursor/sdk";
import type { AppConfig } from "./config.js";

export function buildMcpServers(config: AppConfig): Record<string, McpServerConfig> {
  const telegramEnv: Record<string, string> = {};
  if (config.tgAppId) telegramEnv.TG_APP_ID = config.tgAppId;
  if (config.tgApiHash) telegramEnv.TG_API_HASH = config.tgApiHash;
  if (config.tgSessionPath) telegramEnv.TG_SESSION_PATH = config.tgSessionPath;

  return {
    "gmail-local": {
      type: "stdio",
      command: config.gmailMcpPython,
      args: [config.gmailMcpServerScript],
    },
    telegramMainFi: {
      type: "stdio",
      command: config.telegramNode,
      args: [config.telegramMcpScript],
      env: telegramEnv,
    },
  };
}
