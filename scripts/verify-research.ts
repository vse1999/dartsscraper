import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface VerificationCommand {
  readonly label: string;
  readonly args: readonly string[];
}

interface OwnedTempDirectory {
  readonly path: string;
  readonly realPath: string;
  readonly rootRealPath: string;
}

export function validateVerifierArguments(args: readonly string[]): boolean {
  return args.length === 0;
}

export function verificationCommands(npmCliPath: string): readonly VerificationCommand[] {
  return [
    { label: "TypeScript build", args: [npmCliPath, "run", "build"] },
    { label: "Full test suite (max 2 workers)", args: [npmCliPath, "run", "test", "--", "--maxWorkers=2", "--minWorkers=1"] },
    { label: "Research reuse benchmark", args: [npmCliPath, "run", "research:benchmark"] },
    { label: "Deadline-aware planning benchmark", args: [npmCliPath, "run", "research:planning-benchmark"] },
  ];
}

/** Returns true only for a strict descendant; equality is not containment. */
export function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function createOwnedTempDirectory(workspace: string): Promise<OwnedTempDirectory> {
  const workspaceRealPath = await realpath(workspace);
  const tempRootPath = path.resolve(workspaceRealPath, ".tmp");
  await mkdir(tempRootPath, { recursive: true });
  const rootInfo = await lstat(tempRootPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Workspace .tmp must be a real directory; verifier refused to use a redirected path.");
  }
  const rootRealPath = await realpath(tempRootPath);
  if (!isPathWithin(workspaceRealPath, rootRealPath)) {
    throw new Error("Workspace .tmp resolves outside the repository; verifier refused to create temporary files.");
  }

  const directory = await mkdtemp(path.join(rootRealPath, "verify-research-"));
  const realPathValue = await realpath(directory);
  if (!isPathWithin(rootRealPath, realPathValue)) {
    throw new Error("Created verifier temp directory escaped workspace .tmp; refusing cleanup.");
  }
  return { path: directory, realPath: realPathValue, rootRealPath };
}

async function cleanupOwnedTempDirectory(owned: OwnedTempDirectory): Promise<void> {
  const info = await lstat(owned.path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Verifier temp directory changed type; leaving it untouched for inspection.");
  }
  const currentRealPath = await realpath(owned.path);
  if (!isPathWithin(owned.rootRealPath, currentRealPath) || !samePath(currentRealPath, owned.realPath)) {
    throw new Error("Verifier temp directory moved outside its owned workspace path; leaving it untouched.");
  }
  await rm(owned.path, { recursive: true, force: false });
}

function samePath(first: string, second: string): boolean {
  const left = path.resolve(first);
  const right = path.resolve(second);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function npmCliPathFromEnvironment(): string {
  const npmExecPath = process.env["npm_execpath"];
  if (npmExecPath === undefined || npmExecPath.length === 0 || !path.isAbsolute(npmExecPath)) {
    throw new Error("npm_execpath is unavailable. Run this verifier with `npm run verify:research`.");
  }
  return npmExecPath;
}

async function runCommand(command: VerificationCommand, workspace: string, environment: NodeJS.ProcessEnv): Promise<void> {
  process.stdout.write(`\n[verify:research] ${command.label}\n`);
  await new Promise<void>((resolvePromise, rejectPromise): void => {
    const npmCliPath = command.args[0];
    if (npmCliPath === undefined) {
      rejectPromise(new Error(`${command.label}: no command was configured.`));
      return;
    }
    const args = command.args.slice(1);
    const child = spawn(process.execPath, [npmCliPath, ...args], {
      cwd: workspace,
      env: environment,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", (_error: Error): void => {
      rejectPromise(new Error(`${command.label}: failed to start the configured npm subprocess.`));
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null): void => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const reason = signal === null ? `exit code ${String(code)}` : `signal ${signal}`;
      rejectPromise(new Error(`${command.label} failed with ${reason}; later verification stages were skipped.`));
    });
  });
}

async function verifyResearch(args: readonly string[]): Promise<void> {
  if (!validateVerifierArguments(args)) {
    throw new Error("This verifier accepts no arguments; run `npm run verify:research` without additional parameters.");
  }
  const workspace = await realpath(process.cwd());
  const npmCliPath = npmCliPathFromEnvironment();
  const ownedTemp = await createOwnedTempDirectory(workspace);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    TEMP: ownedTemp.path,
    TMP: ownedTemp.path,
    TMPDIR: ownedTemp.path,
  };
  let stageFailure: unknown;
  let cleanupFailure: unknown;
  try {
    const commands = verificationCommands(npmCliPath);
    for (const command of commands) await runCommand(command, workspace, environment);
  } catch (error: unknown) {
    stageFailure = error;
  }
  try {
    await cleanupOwnedTempDirectory(ownedTemp);
  } catch (error: unknown) {
    cleanupFailure = error;
  }

  if (stageFailure !== undefined && cleanupFailure !== undefined) {
    throw new Error(`${safeFailureMessage(stageFailure)} Cleanup was also blocked: ${safeFailureMessage(cleanupFailure)}`);
  }
  if (stageFailure !== undefined) throw stageFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  process.stdout.write("\n[verify:research] All offline verification stages passed. Production audit remains a separate command.\n");
}

function safeFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected verification failure occurred.";
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && samePath(fileURLToPath(import.meta.url), entry);
}

if (isMainModule()) {
  void verifyResearch(process.argv.slice(2)).catch((error: unknown): void => {
    process.stderr.write(`[verify:research] ${safeFailureMessage(error)}\n`);
    process.exitCode = 1;
  });
}
