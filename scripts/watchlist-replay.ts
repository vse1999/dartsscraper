import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import {
  MAX_OFFLINE_REPLAY_INPUT_BYTES,
  runOfflineWatchlistTick,
  type OfflineWatchlistTickResult,
} from "../src/watchlist/offline-runner.js";

interface ReplayArguments {
  readonly inputPath: string | null;
  readonly error: string | null;
}

function parseArguments(argumentsList: readonly string[]): ReplayArguments {
  if (argumentsList.length !== 2 || argumentsList[0] !== "--input" || argumentsList[1] === undefined || argumentsList[1].trim() === "") {
    return { inputPath: null, error: "Usage: watchlist-replay --input PATH" };
  }
  return { inputPath: argumentsList[1], error: null };
}

function printResult(result: OfflineWatchlistTickResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function readBoundedInput(path: string): Buffer | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > MAX_OFFLINE_REPLAY_INPUT_BYTES) return null;
    const buffer = Buffer.alloc(MAX_OFFLINE_REPLAY_INPUT_BYTES + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    return bytesRead > MAX_OFFLINE_REPLAY_INPUT_BYTES ? null : buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function run(): void {
  const argumentsResult = parseArguments(process.argv.slice(2));
  if (argumentsResult.error !== null || argumentsResult.inputPath === null) {
    printResult({ ok: false, error: argumentsResult.error ?? "Invalid arguments." });
    process.exitCode = 2;
    return;
  }
  const bytes = readBoundedInput(argumentsResult.inputPath);
  if (bytes === null) {
    printResult({ ok: false, error: "Replay input file could not be read." });
    process.exitCode = 2;
    return;
  }
  if (bytes.byteLength > MAX_OFFLINE_REPLAY_INPUT_BYTES) {
    printResult({ ok: false, error: "Replay input file is larger than 1,000,000 bytes." });
    process.exitCode = 2;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    printResult({ ok: false, error: "Replay input file is not valid JSON." });
    process.exitCode = 2;
    return;
  }
  const result = runOfflineWatchlistTick(parsed);
  printResult(result);
  if (!result.ok) process.exitCode = 1;
}

run();
