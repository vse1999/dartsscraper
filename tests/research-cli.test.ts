import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

function command(args: readonly string[], enabled: string, serverless: string = "0"): ReturnType<typeof spawnSync> {
  const environment: NodeJS.ProcessEnv = { ...process.env, RESEARCH_LOCAL_LEDGER_ENABLED: enabled, VERCEL: serverless };
  delete environment.AWS_LAMBDA_FUNCTION_NAME;
  return spawnSync(process.execPath, ["--import", "tsx", path.resolve("scripts/research-workflow.ts"), ...args], {
    cwd: process.cwd(), env: environment, encoding: "utf8", timeout: 5_000,
  });
}

describe("local research CLI safety", () => {
  it("refuses collection without explicit local retention enablement", () => {
    const result = command(["collect", "--input", "docs/research-batch.example.json"], "false");
    expect(result.status).toBe(2);
    expect(String(result.stderr)).toContain("Enable RESEARCH_LOCAL_LEDGER_ENABLED=true");
    expect(String(result.stderr)).toContain("No messages were sent");
    expect(String(result.stdout)).toBe("");
  });

  it("rejects invalid replay identifiers without logging the untrusted value", () => {
    const result = command(["replay", "private-untrusted-input"], "true");
    expect(result.status).toBe(2);
    expect(String(result.stderr)).toContain("validation failed");
    expect(String(result.stderr)).not.toContain("private-untrusted-input");
  });

  it("rejects local retention on serverless before a collection can start", () => {
    const result = command(["collect", "--input", "docs/research-batch.example.json"], "true", "1");
    expect(result.status).toBe(2);
    expect(String(result.stderr)).toContain("disabled on serverless");
  });

  it("rejects fixture discovery source/date/run-label before any collection starts", () => {
    for (const args of [
      ["collect-fixtures", "--source", "untrusted-private-source", "--date", "2026-10-06", "--run-label", "pilot"],
      ["collect-fixtures", "--source", "pdc", "--date", "2026-02-30", "--run-label", "pilot"],
      ["collect-fixtures", "--source", "pdc", "--date", "2026-10-06", "--run-label", "../private-secret"],
    ]) {
      const result = command(args, "true");
      expect(result.status).toBe(2);
      expect(String(result.stdout)).toBe("");
      expect(String(result.stderr)).toContain("validation failed");
      expect(String(result.stderr)).not.toContain("private-secret");
      expect(String(result.stderr)).not.toContain("untrusted-private-source");
    }
  });
});
