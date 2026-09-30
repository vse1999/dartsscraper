import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type {
  Browser,
  BrowserContext,
  Page,
  Request,
  Response,
  Route,
} from "playwright-core";

import { formatEredmenyekDateLabel } from "../src/odds/parser.js";
import {
  createDefaultOddsReader,
  type DefaultOddsReaderOptions,
} from "../src/odds/default.js";

const moduleMocks = vi.hoisted(() => ({
  launch: vi.fn<(options: unknown) => Promise<unknown>>(),
  executablePath: vi.fn<() => Promise<string>>(),
}));

vi.mock("playwright-core", () => ({
  chromium: { launch: moduleMocks.launch },
}));

vi.mock("@sparticuz/chromium", () => ({
  default: {
    args: ["--mock-arg"],
    executablePath: moduleMocks.executablePath,
  },
}));

const SOURCE_URL = "https://www.eredmenyek.com/darts/oddsok/";
const REQUESTED_DATE = "2026-09-30";
const DATE_LABEL = formatEredmenyekDateLabel(REQUESTED_DATE);
const FIXTURE_HTML = readFileSync(new URL("./fixtures/eredmenyek-scheduled.html", import.meta.url), "utf8");
const MAPPING_SCRIPT = JSON.stringify({
  default: [{ main_bookmaker_id: "498", name: "TippmixPro", project_id: "15", geo_ip: "default" }],
});

interface Clock {
  current: Date;
}

interface BrowserPlanOptions {
  readonly html?: string;
  readonly dateLabel?: string;
  readonly responseStatus?: number;
  readonly redirectUrl?: string;
  readonly requiredResourceStatus?: number;
  readonly contextClose?: () => Promise<void>;
  readonly browserClose?: () => Promise<void>;
}

interface BrowserPlan {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly routeHandler: () => RouteHandler | undefined;
  readonly browserClose: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly contextClose: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

type RouteHandler = (route: Route) => Promise<void>;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function validClock(): Clock {
  return { current: new Date("2026-09-30T18:00:00.000Z") };
}

function makeReader(clock: Clock, options: Omit<DefaultOddsReaderOptions, "now"> = {}): ReturnType<typeof createDefaultOddsReader> {
  return createDefaultOddsReader({ ...options, now: (): Date => clock.current });
}

function makeBrowserPlan(options: BrowserPlanOptions = {}): BrowserPlan {
  const responseStatus = options.responseStatus ?? 200;
  const sourceUrl = SOURCE_URL;
  let responseListener: ((response: Response) => void) | undefined;
  let capturedRouteHandler: RouteHandler | undefined;
  const evaluateValues: unknown[] = [
    false,
    false,
    {
      html: options.html ?? FIXTURE_HTML,
      dateLabel: options.dateLabel ?? DATE_LABEL,
      scripts: [MAPPING_SCRIPT],
    },
    { sports: 1, rows: 1, loading: false },
  ];

  const pageValue = {
    setDefaultTimeout: vi.fn<(timeoutMs: number) => void>(),
    on: vi.fn<(event: string, listener: (response: Response) => void) => Page>((event, listener): Page => {
      if (event === "response") responseListener = listener;
      return pageValue as unknown as Page;
    }),
    route: vi.fn<(pattern: string, handler: RouteHandler) => Promise<void>>(async (_pattern, handler): Promise<void> => {
      capturedRouteHandler = handler;
    }),
    goto: vi.fn<(url: string, gotoOptions: unknown) => Promise<Response | null>>(async (): Promise<Response> => {
      if (options.requiredResourceStatus !== undefined) {
        responseListener?.(makeResponse(options.requiredResourceStatus, "script"));
      }
      return makeResponse(responseStatus, "document");
    }),
    waitForFunction: vi.fn<(callback: unknown, arg: unknown, options: unknown) => Promise<unknown>>(
      async (): Promise<unknown> => undefined,
    ),
    evaluate: vi.fn(<T>(_callback: unknown): Promise<T> => Promise.resolve(evaluateValues.shift() as T)),
    url: vi.fn<() => string>(() => options.redirectUrl ?? sourceUrl),
  };
  const contextClose = vi.fn<() => Promise<void>>().mockImplementation(
    options.contextClose ?? (async (): Promise<void> => undefined),
  );
  const browserClose = vi.fn<() => Promise<void>>().mockImplementation(
    options.browserClose ?? (async (): Promise<void> => undefined),
  );
  const contextValue = {
    newPage: vi.fn<() => Promise<Page>>(async (): Promise<Page> => pageValue as unknown as Page),
    close: contextClose,
  };
  const browserValue = {
    newContext: vi.fn<(options: unknown) => Promise<BrowserContext>>(
      async (): Promise<BrowserContext> => contextValue as unknown as BrowserContext,
    ),
    close: browserClose,
  };
  return {
    browser: browserValue as unknown as Browser,
    context: contextValue as unknown as BrowserContext,
    page: pageValue as unknown as Page,
    routeHandler: (): RouteHandler | undefined => capturedRouteHandler,
    browserClose,
    contextClose,
  };
}

function deferred<T>(): Deferred<T> {
  let resolveDeferred: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve): void => { resolveDeferred = resolve; });
  return {
    promise,
    resolve: (value: T): void => { resolveDeferred?.(value); },
  };
}

function installPlans(plans: readonly BrowserPlan[]): void {
  let index = 0;
  moduleMocks.launch.mockImplementation(async (_options: unknown): Promise<unknown> => {
    const plan = plans[index];
    index += 1;
    if (plan === undefined) throw new Error("No browser plan available for this launch.");
    return plan.browser as unknown;
  });
}

function makeResponse(status: number, resourceType: "document" | "script"): Response {
  const request = {
    resourceType: (): string => resourceType,
  };
  return {
    status: (): number => status,
    ok: (): boolean => status >= 200 && status < 400,
    url: (): string => SOURCE_URL,
    request: (): Request => request as unknown as Request,
  } as unknown as Response;
}

function makeRoute(url: string, resourceType: string): {
  readonly route: Route;
  readonly abort: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly continue: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  const abort = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const continueRoute = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const request = {
    url: (): string => url,
    resourceType: (): string => resourceType,
  } as unknown as Request;
  return {
    route: { request: (): Request => request, abort, continue: continueRoute } as unknown as Route,
    abort,
    continue: continueRoute,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve): void => { setTimeout(resolve, 0); });
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve): void => { setTimeout(resolve, 0); });
  }
  throw new Error("Timed out waiting for the mocked browser operation.");
}

beforeEach((): void => {
  moduleMocks.launch.mockReset();
  moduleMocks.executablePath.mockReset();
  moduleMocks.executablePath.mockResolvedValue("C:/mock/chromium");
});

describe("Eredmenyek odds reader", () => {
  it("constructs lazily without launching a browser or resolving Chromium", () => {
    createDefaultOddsReader({ executablePath: "C:/mock/chrome", now: (): Date => new Date("2026-09-30T18:00:00Z") });
    expect(moduleMocks.launch).not.toHaveBeenCalled();
    expect(moduleMocks.executablePath).not.toHaveBeenCalled();
  });

  it("resolves bundled Chromium only when the first read starts", async () => {
    const plan = makeBrowserPlan();
    installPlans([plan]);
    const reader = makeReader(validClock());

    await reader.getOdds("today");

    expect(moduleMocks.executablePath).toHaveBeenCalledOnce();
    expect(moduleMocks.launch).toHaveBeenCalledWith(expect.objectContaining({
      executablePath: "C:/mock/chromium",
      args: ["--mock-arg"],
    }));
  });

  it("shares one same-day browser run between concurrent callers", async () => {
    const clock = validClock();
    const plan = makeBrowserPlan();
    installPlans([plan]);
    const reader = makeReader(clock, { executablePath: "C:/mock/chrome" });

    const [first, second] = await Promise.all([reader.getOdds("today"), reader.getOdds("today")]);

    expect(moduleMocks.launch).toHaveBeenCalledOnce();
    expect(first.matches).toHaveLength(1);
    expect(second.observedAt).toBe(first.observedAt);
  });

  it("keeps a successful report in the five-minute cache with its original observation", async () => {
    const clock = validClock();
    const plan = makeBrowserPlan();
    installPlans([plan]);
    const reader = makeReader(clock, { executablePath: "C:/mock/chrome" });
    const first = await reader.getOdds("today");
    clock.current = new Date(clock.current.getTime() + 4 * 60 * 1_000);
    const cached = await reader.getOdds("today");

    expect(moduleMocks.launch).toHaveBeenCalledOnce();
    expect(cached.observedAt).toBe(first.observedAt);
    expect(cached.matches).toHaveLength(1);
    expect(plan.contextClose).toHaveBeenCalledOnce();
    expect(plan.browserClose).toHaveBeenCalledOnce();
  });

  it("invalidates cache after a clock rollback and after the Budapest date changes", async () => {
    const clock = validClock();
    const firstPlan = makeBrowserPlan();
    const secondPlan = makeBrowserPlan();
    const thirdPlan = makeBrowserPlan();
    installPlans([firstPlan, secondPlan, thirdPlan]);
    const reader = makeReader(clock, { executablePath: "C:/mock/chrome" });
    await reader.getOdds("today");

    clock.current = new Date("2026-09-30T17:59:00.000Z");
    await reader.getOdds("today");
    expect(moduleMocks.launch).toHaveBeenCalledTimes(2);

    clock.current = new Date("2026-10-01T00:01:00.000Z");
    await expect(reader.getOdds("today")).rejects.toThrow("date marker");
    expect(moduleMocks.launch).toHaveBeenCalledTimes(3);
  });

  it("filters elapsed cached scheduled rows without launching again", async () => {
    const clock: Clock = { current: new Date("2026-09-30T18:08:00.000Z") };
    const plan = makeBrowserPlan();
    installPlans([plan]);
    const reader = makeReader(clock, { executablePath: "C:/mock/chrome" });
    await reader.getOdds("today");
    clock.current = new Date("2026-09-30T18:11:00.000Z");
    const elapsed = await reader.getOdds("today");

    expect(moduleMocks.launch).toHaveBeenCalledOnce();
    expect(elapsed.matches).toEqual([]);
    expect(elapsed.warnings.at(-1)).toContain("Filtered 1 match");
  });

  it("does not cancel a shared browser run when one caller aborts", async () => {
    const clock = validClock();
    const launch = deferred<unknown>();
    const plan = makeBrowserPlan();
    moduleMocks.launch.mockImplementation(async (): Promise<unknown> => launch.promise);
    const reader = makeReader(clock, { executablePath: "C:/mock/chrome" });
    const firstController = new AbortController();
    const first = reader.getOdds("today", firstController.signal);
    const second = reader.getOdds("today");
    firstController.abort(new Error("first caller cancelled"));
    await expect(first).rejects.toThrow("first caller cancelled");
    launch.resolve(plan.browser as unknown);
    const result = await second;

    expect(result.matches).toHaveLength(1);
    expect(moduleMocks.launch).toHaveBeenCalledOnce();
  });

  it("cancels a pending launch when the last waiter aborts and closes a late browser", async () => {
    const clock = validClock();
    const launch = deferred<unknown>();
    const plan = makeBrowserPlan();
    moduleMocks.launch.mockImplementation(async (): Promise<unknown> => launch.promise);
    const reader = makeReader(clock, { executablePath: "C:/mock/chrome" });
    const controller = new AbortController();
    const pending = reader.getOdds("today", controller.signal);
    await waitFor((): boolean => moduleMocks.launch.mock.calls.length === 1);
    expect(moduleMocks.launch).toHaveBeenCalledOnce();
    controller.abort(new Error("last caller cancelled"));
    await expect(pending).rejects.toThrow("last caller cancelled");
    launch.resolve(plan.browser as unknown);
    await flushMicrotasks();

    expect(plan.browserClose).toHaveBeenCalledOnce();
    expect(plan.contextClose).not.toHaveBeenCalled();
  });

  it("closes context and browser on parser failure", async () => {
    const plan = makeBrowserPlan({ html: FIXTURE_HTML.replace('id="live-table"', 'id="changed-table"') });
    installPlans([plan]);
    const reader = makeReader(validClock(), { executablePath: "C:/mock/chrome" });

    await expect(reader.getOdds("today")).rejects.toThrow("container");
    expect(plan.contextClose).toHaveBeenCalledOnce();
    expect(plan.browserClose).toHaveBeenCalledOnce();
  });

  it("does not cache a result when browser cleanup fails", async () => {
    const firstPlan = makeBrowserPlan({
      browserClose: async (): Promise<void> => { throw new Error("close failed"); },
    });
    const secondPlan = makeBrowserPlan();
    installPlans([firstPlan, secondPlan]);
    const reader = makeReader(validClock(), { executablePath: "C:/mock/chrome" });

    await expect(reader.getOdds("today")).rejects.toThrow("cleanup failed");
    const second = await reader.getOdds("today");

    expect(second.matches).toHaveLength(1);
    expect(moduleMocks.launch).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid clock during shared-run resolution without caching", async () => {
    const plan = makeBrowserPlan();
    installPlans([plan]);
    const valid = new Date("2026-09-30T18:00:00.000Z");
    const invalid = new Date(Number.NaN);
    const now = vi.fn<() => Date>().mockReturnValueOnce(valid).mockReturnValueOnce(valid).mockReturnValue(invalid);
    const reader = createDefaultOddsReader({ executablePath: "C:/mock/chrome", now });

    await expect(reader.getOdds("today")).rejects.toThrow("invalid date");
    expect(plan.browserClose).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 429])("fails closed when a required subresource returns HTTP %s", async (status: number) => {
    const plan = makeBrowserPlan({ requiredResourceStatus: status });
    installPlans([plan]);
    const reader = makeReader(validClock(), { executablePath: "C:/mock/chrome" });

    await expect(reader.getOdds("today")).rejects.toThrow(`HTTP ${status}`);
    expect(plan.contextClose).toHaveBeenCalledOnce();
    expect(plan.browserClose).toHaveBeenCalledOnce();
  });

  it("fails closed when navigation redirects away from the fixed odds page", async () => {
    const plan = makeBrowserPlan({ redirectUrl: "https://evil.example/odds" });
    installPlans([plan]);
    const reader = makeReader(validClock(), { executablePath: "C:/mock/chrome" });

    await expect(reader.getOdds("today")).rejects.toThrow("redirected away");
  });

  it("blocks external, insecure, credentialed, and other-day document routes", async () => {
    const plan = makeBrowserPlan();
    installPlans([plan]);
    const reader = makeReader(validClock(), { executablePath: "C:/mock/chrome" });
    await reader.getOdds("today");
    const handler = plan.routeHandler();
    if (handler === undefined) throw new Error("Expected page route handler to be installed.");

    const cases = [
      ["https://evil.example/script.js", "script"],
      ["http://www.eredmenyek.com/script.js", "script"],
      ["https://user:pass@www.eredmenyek.com/script.js", "script"],
      ["https://www.eredmenyek.com/darts/oddsok/holnap/", "document"],
    ] as const;
    for (const [url, resourceType] of cases) {
      const route = makeRoute(url, resourceType);
      await handler(route.route);
      expect(route.abort).toHaveBeenCalledOnce();
      expect(route.continue).not.toHaveBeenCalled();
    }
  });
});
