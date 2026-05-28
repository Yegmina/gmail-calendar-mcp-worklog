import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Agent, Cursor, CursorAgentError, type McpServerConfig, type ModelSelection, type SDKAgent, type SDKImage, type SDKMessage } from "@cursor/sdk";
import type { AppConfig } from "./config.js";
import { readSoulAndMemory } from "./contextFiles.js";
import { buildMcpServers } from "./mcpServers.js";
import { runPromptWithOpenAiAgent } from "./openAiAgentRunner.js";
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

const AUTO_MODEL_ID = "auto";
const MODEL_FALLBACKS = ["composer-2", "default"];
const REMOVED_MODEL_IDS = new Set(["composer-2-fast"]);
const execFileAsync = promisify(execFile);

export async function resolveModel(config: AppConfig): Promise<ModelSelection> {
  const requested = config.requestedModelId;
  if (requested === AUTO_MODEL_ID) return { id: AUTO_MODEL_ID };

  const fallback = REMOVED_MODEL_IDS.has(requested) ? MODEL_FALLBACKS[0] : requested || MODEL_FALLBACKS[0];
  try {
    const models = await Cursor.models.list({ apiKey: config.cursorApiKey });
    const ids = new Set(models.map((model) => model.id));
    if (ids.has(requested)) return { id: requested };
    for (const candidate of MODEL_FALLBACKS) {
      if (ids.has(candidate)) return { id: candidate };
    }
  } catch (error) {
    console.warn(
      `Could not list Cursor models; using fallback model '${fallback}'.`,
      error instanceof Error ? error.message : error,
    );
  }
  return { id: fallback };
}

export async function createLocalAgent(config: AppConfig, model?: ModelSelection): Promise<SDKAgent> {
  return Agent.create({
    apiKey: config.cursorApiKey,
    name: "Manager4Yehor local MCP agent",
    model: model ?? await resolveModel(config),
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

export async function runPrompt(config: AppConfig, prompt: string, images?: SDKImage[]): Promise<RunTextResult> {
  if (config.agentRunner === "cursor") {
    return runPromptWithCursor(config, prompt, images);
  }

  if (config.agentRunner === "openai") {
    return runPromptWithOpenAiAgent(config, prompt, images);
  }

  if (config.openAiApiKey) {
    try {
      return await runPromptWithOpenAiAgent(config, prompt, images);
    } catch (error) {
      console.warn(
        "OpenAI Agents SDK runner failed; falling back to Cursor.",
        error instanceof Error ? error.message : error,
      );
    }
  }

  return runPromptWithCursor(config, prompt, images);
}

export async function runPromptWithCursor(config: AppConfig, prompt: string, images?: SDKImage[]): Promise<RunTextResult> {
  if (config.cursorRunner === "cli") {
    return runPromptWithCursorCli(config, prompt, images);
  }

  let agent: SDKAgent | undefined;
  try {
    agent = await createLocalAgent(config);
    return await runPromptWithAgent(agent, prompt, images);
  } catch (error) {
    if (config.cursorRunner === "auto" && isCursorPlanRequired(error)) {
      console.warn("Cursor SDK requires a paid plan; falling back to local Cursor CLI.");
      return runPromptWithCursorCli(config, prompt, images, AUTO_MODEL_ID);
    }
    if (config.cursorRunner === "auto" && isResourceExhausted(error)) {
      console.warn("Cursor run hit resource_exhausted; retrying once with the auto model.");
      if (agent) {
        await agent[Symbol.asyncDispose]();
        agent = undefined;
      }

      try {
        agent = await createLocalAgent(config, { id: AUTO_MODEL_ID });
        return await runPromptWithAgent(agent, prompt, images);
      } catch (autoError) {
        if (!images?.length) {
          console.warn("Cursor SDK auto-model retry failed; falling back to local Cursor CLI auto model.");
          return runPromptWithCursorCli(config, prompt, images, AUTO_MODEL_ID);
        }
        throw autoError;
      }
    }
    throw error;
  } finally {
    if (agent) await agent[Symbol.asyncDispose]();
  }
}

export async function runPlannerExecutor(config: AppConfig, userText: string, chatContext?: string, images?: SDKImage[]): Promise<string> {
  try {
    const { soul, memory } = await readSoulAndMemory(config.repoRoot);
    const promptContext: PromptContext = {
      chatContext,
      defaultTimezone: config.defaultTimezone,
      defaultCalendarId: config.defaultCalendarId,
      soulMarkdown: soul,
      memoryMarkdown: memory,
    };
    const planner = await runPrompt(config, buildPlannerPrompt(userText, promptContext), images);
    if (planner.status !== "finished") {
      return failedRunMessage("Planner", planner);
    }

    const executor = await runPrompt(config, buildExecutorPrompt(userText, planner.text, promptContext), images);
    if (executor.status !== "finished") {
      return failedRunMessage("Executor", executor);
    }

    return withCalendarUpdateNotice(sanitizeUserReply(executor.text || "(no response)"), executor.calendarUpdates);
  } catch (error) {
    if (error instanceof CursorAgentError) {
      return `Cursor SDK startup/config error: ${error.message}`;
    }
    return `Unexpected bot error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function runPromptWithCursorCli(
  config: AppConfig,
  prompt: string,
  images?: SDKImage[],
  model = config.cursorCliModel,
): Promise<RunTextResult> {
  if (images?.length) {
    return {
      text: "Image handling needs the Cursor SDK runner. Text requests can run through the local Cursor CLI fallback.",
      status: "error",
      agentId: "cursor-cli",
      runId: cliRunId(),
      calendarUpdates: [],
    };
  }

  const result = await runCursorCliOnce(config, prompt, model);
  if (result.status === "error" && model !== AUTO_MODEL_ID && isResourceExhausted(result.text)) {
    console.warn(`Cursor CLI model '${model}' hit resource_exhausted; retrying once with model '${AUTO_MODEL_ID}'.`);
    return runCursorCliOnce(config, prompt, AUTO_MODEL_ID);
  }
  return result;
}

async function runCursorCliOnce(config: AppConfig, prompt: string, model: string): Promise<RunTextResult> {
  const cliHome = await createCursorCliHome(config);
  try {
    const { stdout, stderr } = await execFileAsync(
      config.cursorCliBinary,
      [
        "-p",
        "--trust",
        "--force",
        "--approve-mcps",
        "--model",
        model,
        "--workspace",
        config.repoRoot,
        prompt,
      ],
      {
        cwd: config.repoRoot,
        env: {
          ...process.env,
          CURSOR_API_KEY: config.cursorApiKey,
          HOME: cliHome,
        },
        maxBuffer: 5 * 1024 * 1024,
        timeout: 10 * 60_000,
      },
    );
    return {
      text: (stdout || stderr).trim(),
      status: "finished",
      agentId: "cursor-cli",
      runId: cliRunId(),
      calendarUpdates: [],
    };
  } catch (error) {
    const maybe = error as { stdout?: string; stderr?: string; message?: string };
    const text = [maybe.stdout, maybe.stderr, maybe.message].filter(Boolean).join("\n").trim();
    return {
      text: text || String(error),
      status: "error",
      agentId: "cursor-cli",
      runId: cliRunId(),
      calendarUpdates: [],
    };
  } finally {
    await rm(cliHome, { recursive: true, force: true });
  }
}

async function createCursorCliHome(config: AppConfig): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "manager4yehor-cursor-"));
  const cursorDir = join(home, ".cursor");
  await mkdir(cursorDir, { recursive: true });
  await writeFile(
    join(cursorDir, "mcp.json"),
    `${JSON.stringify({ mcpServers: buildCursorCliMcpServers(config) }, null, 2)}\n`,
  );
  return home;
}

function buildCursorCliMcpServers(config: AppConfig): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(buildMcpServers(config)).map(([name, server]) => [name, cursorCliMcpServer(server)]),
  );
}

function cursorCliMcpServer(server: McpServerConfig): Record<string, unknown> {
  if ("command" in server) {
    return compactObject({
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: server.cwd,
    });
  }

  return compactObject({
    url: server.url,
    headers: server.headers,
    auth: server.auth,
  });
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function isCursorPlanRequired(error: unknown): boolean {
  const maybe = error as { code?: unknown; message?: unknown };
  return maybe.code === "plan_required" || String(maybe.message ?? error).includes("[plan_required]");
}

function isResourceExhausted(error: unknown): boolean {
  const maybe = error as { code?: unknown; message?: unknown; stdout?: unknown; stderr?: unknown };
  if (maybe.code === "resource_exhausted") return true;
  const text = [maybe.message, maybe.stdout, maybe.stderr, error].map((value) => String(value ?? "")).join("\n");
  return /\bresource[_-]exhausted\b/i.test(text);
}

function cliRunId(): string {
  return `cli-${Date.now().toString(36)}`;
}

function failedRunMessage(stage: string, result: RunTextResult): string {
  const detail = result.text.trim();
  if (detail) return `${stage} failed with status ${result.status}: ${detail}`;
  return `${stage} failed with status ${result.status}. run=${result.runId}`;
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
