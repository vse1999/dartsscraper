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
import { createCollectionBudget } from "../src/research/collection-budget.js";
import { waitWithSignal } from "../src/services/cancellation.js";
import { collectFixtureResearch } from "../src/research/fixture-collection.js";
import { createFixtureDiscovery } from "../src/research/fixture-discovery.js";
import { FixtureNameResolver } from "../src/modus/fixture-name-resolver.js";
import { IsoDateSchema } from "../src/agent/date.js";
import { assessResearchQuality } from "../src/research/quality.js";
import { diagnoseResearchCoverage } from "../src/research/coverage.js";
import type { PlayerIdentity } from "../src/schemas/player.js";

function createReader(storage: ReturnType<typeof createResearchStorage>): {
  readonly client: DartsOrakelClient;
  readonly resolver: PlayerResolver;
  readonly reader: ResearchHistoryService;
} {
  const client = new DartsOrakelClient({ minRequestIntervalMs: 3_200, maxRetries: 2,
    fetchImpl: withLocalReaderGate(createJinaReaderFetch(), path.resolve(process.cwd(), ".cache", "research-control")) });
  const resolver = new PlayerResolver(client);
  return { client, resolver, reader: new ResearchHistoryService({ ...storage, resolver, scraper: new DartsOrakelScraper(client) }) };
}

async function main(args: readonly string[]): Promise<void> {
  const storage = createResearchStorage();
  if (storage.persistence !== "local") throw new Error("Local research workflow requires explicit RESEARCH_LOCAL_LEDGER_ENABLED=true. No collection has started.");
  const [command, first, second, third] = args;
  const directory = path.resolve(process.cwd(), ".cache", "research-workflow");
  if (command === "collect" && first === "--input" && second !== undefined && args.length === 3) {
    const budget = createCollectionBudget();
    try {
      const input = await waitWithSignal(readLocalJson(path.resolve(second)), budget.workSignal);
      if (input === null) throw new Error("Research input file does not exist.");
      const { reader } = createReader(storage);
      const result = await collectResearchBatch(input, { directory, ledger: storage.ledger, reader, budget });
      process.stdout.write(`${JSON.stringify({ ...result, diagnostics: reader.diagnostics() }, null, 2)}\n`);
      if (result.status !== "complete") process.exitCode = 1;
    } finally { budget.close(); }
    return;
  }
  if (command === "collect-fixtures" && args.length === 7 && first === "--source" && args[3] === "--date" && args[5] === "--run-label") {
    const source = z.enum(["pdc", "modus"]).parse(second);
    const date = IsoDateSchema.parse(args[4]);
    const runLabel = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u).parse(args[6]);
    const { client, reader } = createReader(storage);
    const strictResolver = new FixtureNameResolver(client);
    const result = await collectFixtureResearch({ source, date, runLabel }, {
      directory, ledger: storage.ledger, reader, discover: createFixtureDiscovery(client, source, date, strictResolver),
      resolveParticipant: async (name: string, signal?: AbortSignal): Promise<PlayerIdentity> => {
        return strictResolver.resolvePlayerIdentity(name, signal);
      },
    });
    process.stdout.write(`${JSON.stringify({ ...result, diagnostics: reader.diagnostics() }, null, 2)}\n`);
    if (result.status !== "complete") process.exitCode = 1;
    return;
  }
  if (command === "replay" && first !== undefined && args.length === 2) {
    const evidence = await storage.ledger.read(first);
    if (evidence === null) throw new Error("Evidence ID was not found in this local ledger.");
    process.stdout.write(`${JSON.stringify({ evidence, research: summarizeResearchHistory(evidence.matches),
      assessment: assessResearchQuality(evidence.matches, { evidence, persistence: "local" }),
      coverage: diagnoseResearchCoverage(evidence.matches, { requestedRowCount: evidence.requestedCount }),
      replay: true, deliveryAuthorized: false }, null, 2)}\n`);
    return;
  }
  if (command === "feedback" && first !== undefined && second !== undefined && third !== undefined && args.length === 4) {
    const record = await recordResearchFeedback({ evidenceId: first, label: second, reason: third }, storage.ledger, directory);
    process.stdout.write(`${JSON.stringify({ feedback: record, deliveryAuthorized: false }, null, 2)}\n`);
    return;
  }
  throw new Error("Usage: research collect --input FILE | research collect-fixtures --source pdc|modus --date YYYY-MM-DD --run-label LABEL | research replay EVIDENCE_ID | research feedback EVIDENCE_ID useful|not-useful|incorrect time-saved|source-error|identity-error|missing-data|unclear|other");
}

function publicFailure(error: unknown): string {
  if (error instanceof z.ZodError) return "Input or stored-record validation failed. Use the documented version-1 input/feedback format and a 64-character evidence ID.";
  const code = localErrorCode(error);
  if (code === "EACCES" || code === "EPERM") return "Storage access failed. Check permissions on the workspace .cache directories.";
  if (error instanceof Error) {
    if (error.message.startsWith("Usage:")) return "Usage: npm run research -- collect --input FILE | collect-fixtures --source pdc|modus --date YYYY-MM-DD --run-label LABEL | replay EVIDENCE_ID | feedback EVIDENCE_ID LABEL REASON.";
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
