import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createDartsResearchAgent } from "./agent/factory.js";
import { DEFAULT_OLLAMA_MODEL } from "./agent/config.js";
import type { AgentConversationMessage } from "./agent/harness.js";

interface AgentCliArguments { query: string | undefined; debug: boolean; model: string | undefined; }
async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const agent = createDartsResearchAgent({ debug: args.debug, ...(args.model === undefined ? {} : { model: args.model }) });
  if (args.query !== undefined) {
    const result = await agent.run(args.query);
    process.stdout.write(`${result.answer}\n`);
    return;
  }
  const readline = createInterface({ input, output });
  const history: AgentConversationMessage[] = [];
  process.stdout.write(`Local darts research agent (${args.model ?? process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL}). Type exit to quit.\n`);
  try {
    while (true) {
      const query = (await readline.question("darts> ")).trim();
      if (query === "exit" || query === "quit") break;
      if (query === "") continue;
      try {
        const result = await agent.run(query, { history });
        process.stdout.write(`${result.answer}\n`);
        history.push({ role: "user", content: query }, { role: "assistant", content: result.answer });
        if (history.length > 20) history.splice(0, history.length - 20);
      } catch (error: unknown) {
        process.stderr.write(`${error instanceof Error ? error.message : "Unexpected agent error."}\n`);
      }
    }
  } finally { readline.close(); }
}
function parseArguments(args: readonly string[]): AgentCliArguments {
  let debug = false;
  let model: string | undefined;
  const queryParts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--debug") { debug = true; continue; }
    if (argument === "--model") {
      model = args[index + 1];
      if (model === undefined || model.startsWith("--")) throw new Error("--model requires an Ollama model name.");
      index += 1; continue;
    }
    if (argument === "--help") {
      process.stdout.write(`Usage: npm run agent -- [--debug] [--model ${DEFAULT_OLLAMA_MODEL}] ["research request"]\n`);
      return { query: undefined, debug, model };
    }
    if (argument !== undefined) queryParts.push(argument);
  }
  const query = queryParts.join(" ").trim();
  return { query: query === "" ? undefined : query, debug, model };
}
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Unexpected agent error."}\n`);
  process.exitCode = 1;
});

