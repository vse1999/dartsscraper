import { normalizePlayerName } from "../player/resolver.js";
import { PlayerNotFoundError } from "../errors.js";
import type { PlayerIdentity } from "../schemas/player.js";
import { abortError } from "../services/cancellation.js";

export interface ValueResolution {
  readonly status: "available" | "unresolved" | "failed" | "timed_out" | "cancelled";
  readonly identity: PlayerIdentity | null;
  readonly error: string | null;
}

export function unresolvedResolution(name: string): ValueResolution { return { status: "unresolved", identity: null, error: new PlayerNotFoundError(name).message }; }
export function signalStatus(signal: AbortSignal): "cancelled" | "timed_out" { return isDeadlineSignal(signal) ? "timed_out" : "cancelled"; }
export function identityKey(identity: PlayerIdentity | null): string { return identity === null ? "" : String(identity.id); }
export function uniqueById(players: readonly PlayerIdentity[]): readonly PlayerIdentity[] { return [...new Map(players.map((player): readonly [number, PlayerIdentity] => [player.id, player])).values()]; }
export function normalizeForMatch(value: string): string { return normalizePlayerName(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
export function nameParts(value: string): { readonly surname: string; readonly initial: string } | null {
  const normalized = normalizeForMatch(value);
  const parts = normalized.split(" ").filter((part: string): boolean => part !== "");
  if (parts.length < 2) return null;
  const trailingInitial = parts.at(-1);
  const leadingInitial = parts[0];
  if (trailingInitial !== undefined && trailingInitial.length === 1 && leadingInitial !== undefined && leadingInitial.length > 1) {
    const surname = parts.slice(0, -1).join(" ");
    return surname === "" ? null : { surname, initial: trailingInitial };
  }
  if (leadingInitial !== undefined && leadingInitial.length === 1) {
    const surname = parts.slice(1).join(" ");
    return surname === "" ? null : { surname, initial: leadingInitial };
  }
  const surname = parts.slice(1).join(" ");
  return surname === "" || leadingInitial === undefined ? null : { surname, initial: leadingInitial[0] ?? "" };
}
export function abbreviatedNameParts(value: string): { readonly surname: string; readonly initial: string } | null {
  const parts = normalizeForMatch(value).split(" ").filter((part: string): boolean => part !== "");
  if (parts.length < 2) return null;
  const first = parts[0];
  const last = parts.at(-1);
  if ((first?.length !== 1 && last?.length !== 1) || first === undefined || last === undefined) return null;
  return nameParts(value);
}
export function samePlayerName(left: string, right: string): boolean { return normalizeForMatch(left) === normalizeForMatch(right); }
export function validDate(value: Date, label: string): Date { if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${label} returned an invalid date.`); return value; }
export function positiveInteger(value: number, label: string): number { if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`); return value; }
export function errorMessage(error: unknown): string { return error instanceof Error && error.message.trim() !== "" ? error.message : "Unexpected value research error."; }
export function isTimeout(error: unknown): boolean { const message = errorMessage(error).toLocaleLowerCase("en-US"); return message.includes("timed out") || message.includes("timeout"); }
export function isDeadlineSignal(signal: AbortSignal): boolean { return signal.aborted && errorMessage(signal.reason).toLocaleLowerCase("en-US").includes("deadline"); }

export async function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => { if (settled) return; settled = true; cleanup(); reject(abortError(signal)); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value: T): void => { if (settled) return; settled = true; cleanup(); resolve(value); }, (error: unknown): void => { if (settled) return; settled = true; cleanup(); reject(error); });
  });
}
