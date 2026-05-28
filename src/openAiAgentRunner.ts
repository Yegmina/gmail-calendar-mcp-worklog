import {
  Agent as OpenAiAgent,
  MCPServerStdio,
  connectMcpServers,
  run,
  type AgentInputItem,
  type MCPServer,
} from "@openai/agents";
import type { SDKImage } from "@cursor/sdk";
import type { AppConfig } from "./config.js";
import { buildMcpServers } from "./mcpServers.js";
import type { RunTextResult } from "./agentRunner.js";

export async function runPromptWithOpenAiAgent(
  config: AppConfig,
  prompt: string,
  images?: SDKImage[],
): Promise<RunTextResult> {
  if (!config.openAiApiKey) {
    throw new Error("Missing OPENAI_API_KEY for OpenAI Agents SDK runner.");
  }

  const rawServers = createOpenAiMcpServers(config);
  const servers = await connectMcpServers(rawServers, {
    connectInParallel: true,
    strict: false,
  });

  try {
    for (const [server, error] of servers.errors) {
      console.warn(`OpenAI MCP server '${server.name}' failed to connect: ${error.message}`);
    }

    const agent = new OpenAiAgent({
      name: "Manager4Yehor OpenAI agent",
      instructions: "Follow the user prompt exactly. Use MCP tools where the prompt allows them.",
      ...(config.openAiAgentModel ? { model: config.openAiAgentModel } : {}),
      mcpServers: servers.active,
      mcpConfig: {
        convertSchemasToStrict: true,
        includeServerInToolNames: true,
        errorFunction: null,
      },
    });

    const result = await run(agent, openAiInput(prompt, images), {
      maxTurns: 20,
    });

    return {
      text: String(result.finalOutput ?? "").trim(),
      status: result.interruptions.length ? "error" : "finished",
      agentId: "openai-agents",
      runId: result.lastResponseId ?? openAiRunId(),
      calendarUpdates: calendarUpdatesFromOpenAiItems(result.newItems),
    };
  } finally {
    await servers.close();
  }
}

function createOpenAiMcpServers(config: AppConfig): MCPServer[] {
  return Object.entries(buildMcpServers(config)).flatMap(([name, server]) => {
    if (!("command" in server)) {
      console.warn(`Skipping non-stdio MCP server '${name}' for OpenAI local Agents SDK runner.`);
      return [];
    }

    return [
      new MCPServerStdio({
        name,
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        env: cleanEnv({ ...process.env, ...server.env }),
        cacheToolsList: true,
      }),
    ];
  });
}

function openAiInput(prompt: string, images?: SDKImage[]): string | AgentInputItem[] {
  if (!images?.length) return prompt;
  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: prompt,
        },
        ...images.map((image) => ({
          type: "input_image" as const,
          image: imageUrl(image),
          detail: "auto",
        })),
      ],
    },
  ];
}

function imageUrl(image: SDKImage): string {
  if ("url" in image) return image.url;
  return `data:${image.mimeType};base64,${image.data}`;
}

function calendarUpdatesFromOpenAiItems(items: unknown[]): RunTextResult["calendarUpdates"] {
  const updates: RunTextResult["calendarUpdates"] = [];
  for (const item of items) {
    const maybe = item as {
      type?: unknown;
      rawItem?: { name?: unknown };
      output?: unknown;
    };
    if (maybe.type !== "tool_call_output_item") continue;
    const name = String(maybe.rawItem?.name ?? "").toLowerCase();
    if (!name.includes("create_event") && !name.includes("delete_event")) continue;
    updates.push({
      action: name.includes("create_event") ? "created" : "deleted",
      detail: stringifyOpenAiToolOutput(maybe.output),
    });
  }
  return updates;
}

function stringifyOpenAiToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "text" in output) {
    const text = (output as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return JSON.stringify(output ?? {});
}

function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function openAiRunId(): string {
  return `openai-${Date.now().toString(36)}`;
}
