import { Agent, Cursor, CursorAgentError, type ModelSelection, type SDKAgent, type SDKImage, type SDKMessage } from "@cursor/sdk";
import type { AppConfig } from "./config.js";
import { readSoulAndMemory } from "./contextFiles.js";
import { buildMcpServers } from "./mcpServers.js";
import { buildExecutorPrompt, buildPlannerPrompt } from "./prompts.js";
import type { PromptContext } from "./prompts.js";

export type RunTextResult = {
  text: string;
  status: "finished" | "error" | "cancelled";
  agentId: string;
  runId: string;
  calendarUpdates: CalendarUpdate[];
};

type CalendarUpdate = {
  action: "created" | "deleted";
  detail: string;
};

export async function resolveModel(config: AppConfig): Promise<ModelSelection> {
  const requested = config.requestedModelId;
  try {
    const models = await Cursor.models.list({ apiKey: config.cursorApiKey });
    const ids = new Set(models.map((model) => model.id));
    if (ids.has(requested)) return { id: requested };
    if (ids.has("composer-2-fast")) return { id: "composer-2-fast" };
    if (ids.has("composer-2")) return { id: "composer-2" };
  } catch (error) {
    console.warn(`Could not list Cursor models; trying requested model '${requested}'.`, error);
  }
  return { id: requested || "auto" };
}

export async function createLocalAgent(config: AppConfig): Promise<SDKAgent> {
  return Agent.create({
    apiKey: config.cursorApiKey,
    name: "Manager4Yehor local MCP agent",
    model: await resolveModel(config),
    local: {
      cwd: config.repoRoot,
      settingSources: [],
      sandboxOptions: { enabled: false },
    },
    mcpServers: buildMcpServers(config),
  });
}

export async function runPromptWithAgent(agent: SDKAgent, prompt: string, images?: SDKImage[]): Promise<RunTextResult> {
  const message = images?.length ? { text: prompt, images } : prompt;
  const run = await agent.send(message, { local: { force: true } });
  let text = "";
  const calendarUpdates: CalendarUpdate[] = [];

  if (run.supports("stream")) {
    for await (const event of run.stream()) {
      text += textFromEvent(event);
      const update = calendarUpdateFromEvent(event);
      if (update) calendarUpdates.push(update);
    }
  }

  const result = await run.wait();
  if (!text.trim() && result.result) text = result.result;
  return {
    text: text.trim(),
    status: result.status,
    agentId: run.agentId,
    runId: run.id,
    calendarUpdates,
  };
}

export async function runPlannerExecutor(config: AppConfig, userText: string, chatContext?: string, images?: SDKImage[]): Promise<string> {
  let agent: SDKAgent | undefined;
  try {
    agent = await createLocalAgent(config);
    const { soul, memory } = await readSoulAndMemory(config.repoRoot);
    const promptContext: PromptContext = {
      chatContext,
      defaultTimezone: config.defaultTimezone,
      defaultCalendarId: config.defaultCalendarId,
      soulMarkdown: soul,
      memoryMarkdown: memory,
    };
    const planner = await runPromptWithAgent(agent, buildPlannerPrompt(userText, promptContext), images);
    if (planner.status !== "finished") {
      return `Planner failed with status ${planner.status}. run=${planner.runId}`;
    }

    const executor = await runPromptWithAgent(agent, buildExecutorPrompt(userText, planner.text, promptContext), images);
    if (executor.status !== "finished") {
      return `Executor failed with status ${executor.status}. run=${executor.runId}`;
    }

    return withCalendarUpdateNotice(sanitizeUserReply(executor.text || "(no response)"), executor.calendarUpdates);
  } catch (error) {
    if (error instanceof CursorAgentError) {
      return `Cursor SDK startup/config error: ${error.message}`;
    }
    return `Unexpected bot error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (agent) await agent[Symbol.asyncDispose]();
  }
}

function textFromEvent(event: SDKMessage): string {
  if (event.type !== "assistant") return "";
  return event.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function sanitizeUserReply(text: string): string {
  return text
    .replace(/^(Fetching|Calling|Discovering|Checking|Reading) [^\n]*\n\n?/i, "")
    .replace(/^I (will|am going to) (fetch|call|check|read) [^\n]*\n\n?/i, "")
    .trim();
}

function calendarUpdateFromEvent(event: SDKMessage): CalendarUpdate | undefined {
  if (event.type !== "tool_call" || event.status !== "completed") return undefined;
  const name = event.name.toLowerCase();
  if (!name.includes("create_event") && !name.includes("delete_event")) return undefined;
  return {
    action: name.includes("create_event") ? "created" : "deleted",
    detail: stringifyToolResult(event.result),
  };
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "result" in result) {
    const value = (result as { result?: unknown }).result;
    if (typeof value === "string") return value;
  }
  return JSON.stringify(result ?? {});
}

function withCalendarUpdateNotice(text: string, updates: CalendarUpdate[]): string {
  if (updates.length === 0) return text;
  const alreadyNotifies = /calendar (updated|created|deleted)|event (created|deleted|added|removed)|done\./i.test(text);
  if (alreadyNotifies) return text;

  const details = updates
    .map((update) => `- ${update.action}: ${update.detail}`)
    .join("\n");
  return `Calendar updated.\n${details}\n\n${text}`.trim();
}
