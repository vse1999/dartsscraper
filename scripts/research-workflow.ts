import path from "node:path";
import { DartsOrakelClient } from "../src/dartsorakel/client.js";
import { DartsOrakelScraper } from "../src/dartsorakel/scraper.js";
import { createJinaReaderFetch } from "../src/dartsorakel/reader-fetch.js";
import { PlayerResolver } from "../src/player/resolver.js";
import { createResearchStorage } from "../src/research/config.js";
import { ResearchHistoryService } from "../src/research/history-service.js";
import { collectResearchBatch } from "../src/research/collection-runner.js";
import { recordResearchFeedback } from "../src/research/feedback.js";
import { readLocalJson } from "../src/research/local-files.js";
import { summarizeResearchHistory } from "../src/research/statistics.js";
import { withLocalReaderGate } from "../src/research/request-gate.js";
import { z } from "zod";
import { localErrorCode } from "../src/research/local-files.js";

async function main(args: readonly string[]): Promise<void> {
  const storage = createResearchStorage();
  if (storage.persistence !== "local") throw new Error("Local research workflow requires explicit RESEARCH_LOCAL_LEDGER_ENABLED=true. No collection has started.");
  const [command, first, second, third] = args;
  const directory = path.resolve(process.cwd(), ".cache", "research-workflow");
  if (command === "collect" && first === "--input" && second !== undefined && args.length === 3) {
    const input = await readLocalJson(path.resolve(second));
    if (input === null) throw new Error("Research input file does not exist.");
    const client = new DartsOrakelClient({ minRequestIntervalMs: 3_200, maxRetries: 2,
      fetchImpl: withLocalReaderGate(createJinaReaderFetch(), path.resolve(process.cwd(), ".cache", "research-control")) });
    const reader = new ResearchHistoryService({ ...storage, resolver: new PlayerResolver(client), scraper: new DartsOrakelScraper(client) });
    const result = await collectResearchBatch(input, { directory, ledger: storage.ledger, reader });
    process.stdout.write(`${JSON.stringify({ ...result, diagnostics: reader.diagnostics() }, null, 2)}\n`);
    if (result.status !== "complete") process.exitCode = 1;
    return;
  }
  if (command === "replay" && first !== undefined && args.length === 2) {
    const evidence = await storage.ledger.read(first);
    if (evidence === null) throw new Error("Evidence ID was not found in this local ledger.");
    process.stdout.write(`${JSON.stringify({ evidence, research: summarizeResearchHistory(evidence.matches), replay: true, deliveryAuthorized: false }, null, 2)}\n`);
    return;
  }
  if (command === "feedback" && first !== undefined && second !== undefined && third !== undefined && args.length === 4) {
    const record = await recordResearchFeedback({ evidenceId: first, label: second, reason: third }, storage.ledger, directory);
    process.stdout.write(`${JSON.stringify({ feedback: record, deliveryAuthorized: false }, null, 2)}\n`);
    return;
  }
  throw new Error("Usage: research collect --input FILE | research replay EVIDENCE_ID | research feedback EVIDENCE_ID useful|not-useful|incorrect time-saved|source-error|identity-error|missing-data|unclear|other");
}

function publicFailure(error: unknown): string {
  if (error instanceof z.ZodError) return "Input or stored-record validation failed. Use the documented version-1 input/feedback format and a 64-character evidence ID.";
  const code = localErrorCode(error);
  if (code === "EACCES" || code === "EPERM") return "Storage access failed. Check permissions on the workspace .cache directories.";
  if (error instanceof Error) {
    if (error.message.startsWith("Usage:")) return "Usage: npm run research -- collect --input FILE | replay EVIDENCE_ID | feedback EVIDENCE_ID LABEL REASON.";
    if (error.message.includes("locked")) return "Local storage is locked. Confirm collection/writes stopped before explicitly recovering an abandoned lock.";
    if (error.message.includes("RESEARCH_LOCAL_LEDGER_ENABLED") || error.message.includes("serverless")) return "Enable RESEARCH_LOCAL_LEDGER_ENABLED=true only on a local host; keep it disabled on serverless hosts.";
    if (error.message.includes("not found") || error.message.includes("does not exist")) return "Input/evidence was not found. Verify the local input path or replay a valid evidence ID from this workspace.";
  }
  return "Check input/record integrity, storage capacity and workspace permissions; no unsafe fallback was attempted.";
}

void main(process.argv.slice(2)).catch((error: unknown): void => {
  // Never print arbitrary provider exceptions, input payloads or credential-bearing URLs.
  process.stderr.write(`Research workflow failed. ${publicFailure(error)} No messages were sent.\n`);
  process.exitCode = 2;
});
