import { loadConfig } from "./config.js";
import { createLocalAgent, runPromptWithAgent } from "./agentRunner.js";
import { MCP_HEALTH_PROMPT } from "./prompts.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const agent = await createLocalAgent(config);
  try {
    const result = await runPromptWithAgent(agent, MCP_HEALTH_PROMPT);
    console.log(result.text || "(no health output)");
    console.log(`\nstatus=${result.status} agent=${result.agentId} run=${result.runId}`);
    if (result.status !== "finished") process.exitCode = 2;
  } finally {
    await agent[Symbol.asyncDispose]();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
}).then(() => {
  process.exit(process.exitCode ?? 0);
});
