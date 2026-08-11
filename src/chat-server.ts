import { z } from "zod";

import { DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_KEEP_ALIVE, DEFAULT_OLLAMA_MODEL } from "./agent/config.js";
import { startChatServer } from "./chat/server.js";

const EnvironmentSchema = z.object({
  CHAT_HOST: z.string().trim().min(1).default("127.0.0.1"),
  CHAT_PORT: z.coerce.number().int().min(1).max(65_535).default(3_210),
  OLLAMA_MODEL: z.string().trim().min(1).max(200).default(DEFAULT_OLLAMA_MODEL),
  OLLAMA_BASE_URL: z.string().url().default(DEFAULT_OLLAMA_BASE_URL),
  OLLAMA_KEEP_ALIVE: z.string().trim().regex(/^(?:-1|0|\d+(?:ms|s|m|h))$/u).default(DEFAULT_OLLAMA_KEEP_ALIVE),
});

async function main(): Promise<void> {
  const parsed = EnvironmentSchema.safeParse(process.env);
  if (!parsed.success) throw new Error(`Invalid chatbot configuration: ${parsed.error.issues[0]?.message ?? "unknown validation error"}.`);
  const started = await startChatServer({
    host: parsed.data.CHAT_HOST,
    port: parsed.data.CHAT_PORT,
    model: parsed.data.OLLAMA_MODEL,
    ollamaBaseUrl: parsed.data.OLLAMA_BASE_URL,
    ollamaKeepAlive: parsed.data.OLLAMA_KEEP_ALIVE,
  });
  process.stdout.write(`Darts chatbot ready at ${started.url}\nModel: ${parsed.data.OLLAMA_MODEL}\nPress Ctrl+C to stop.\n`);

  const stop = (signal: NodeJS.Signals): void => {
    process.stdout.write(`\nReceived ${signal}; stopping chatbot.\n`);
    started.server.close((error) => {
      if (error !== undefined) {
        process.stderr.write(`Unable to close chatbot cleanly: ${error.message}\n`);
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Unable to start the chatbot."}\n`);
  process.exitCode = 1;
});
