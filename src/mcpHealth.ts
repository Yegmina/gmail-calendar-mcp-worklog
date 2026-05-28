import { loadConfig } from "./config.js";
import { runPrompt } from "./agentRunner.js";
import { MCP_HEALTH_PROMPT } from "./prompts.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const result = await runPrompt(config, MCP_HEALTH_PROMPT);
  console.log(result.text || "(no health output)");
  console.log(`\nstatus=${result.status} agent=${result.agentId} run=${result.runId}`);
  if (result.status !== "finished") process.exitCode = 2;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
}).then(() => {
  process.exit(process.exitCode ?? 0);
});
