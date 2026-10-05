import path from "node:path";
import { FileEvidenceLedger, MemoryEvidenceLedger, type EvidenceLedger } from "./ledger.js";
import { createJinaReaderFetch } from "../dartsorakel/reader-fetch.js";
import { withLocalReaderGate } from "./request-gate.js";

export interface ResearchStorage {
  readonly ledger: EvidenceLedger;
  readonly persistence: "memory" | "local";
}

/** Opt-in local evidence retention. Serverless files are not durable shared storage. */
export function createResearchStorage(environment: NodeJS.ProcessEnv = process.env): ResearchStorage {
  const enabled = environment.RESEARCH_LOCAL_LEDGER_ENABLED;
  if (enabled !== undefined && enabled !== "true" && enabled !== "false") {
    throw new Error("RESEARCH_LOCAL_LEDGER_ENABLED must be true or false.");
  }
  if (enabled !== "true") return { ledger: new MemoryEvidenceLedger(), persistence: "memory" };
  if (environment.VERCEL === "1" || environment.AWS_LAMBDA_FUNCTION_NAME !== undefined) {
    throw new Error("Local research retention is unavailable on serverless hosts. Disable RESEARCH_LOCAL_LEDGER_ENABLED or provide an approved durable adapter.");
  }
  // Keep the directory fixed and ignored; untrusted data cannot select a retention path.
  return { ledger: new FileEvidenceLedger(path.resolve(process.cwd(), ".cache", "research-evidence")), persistence: "local" };
}

export function createResearchReaderFetch(environment: NodeJS.ProcessEnv = process.env): typeof fetch {
  const transport = createJinaReaderFetch();
  if (environment.RESEARCH_LOCAL_LEDGER_ENABLED !== "true") return transport;
  if (environment.VERCEL === "1" || environment.AWS_LAMBDA_FUNCTION_NAME !== undefined) {
    throw new Error("Local Reader reservations cannot coordinate serverless instances; disable local retention.");
  }
  return withLocalReaderGate(transport, path.resolve(process.cwd(), ".cache", "research-control"));
}
