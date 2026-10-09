import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { chromium, type Browser } from "playwright-core";
import { parseLabAnalyses, renderReportImageHtml } from "./report-layouts.js";

interface Sample {
  readonly wallMs: number;
  readonly nodeCpuMs: number;
  readonly bytes: number;
  readonly launchMs?: number;
  readonly renderMs?: number;
  readonly closeMs?: number;
}

function statistics(values: readonly number[]): { readonly median: number; readonly p95: number; readonly max: number } {
  const sorted = [...values].sort((a: number, b: number): number => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
  const maximum = sorted.at(-1);
  if (middle === undefined || p95 === undefined || maximum === undefined) throw new Error("Benchmark has no observations.");
  return { median: Number(middle.toFixed(2)), p95: Number(p95.toFixed(2)), max: Number(maximum.toFixed(2)) };
}

async function render(browser: Browser, html: string): Promise<number> {
  const page = await browser.newPage({ viewport: { width: 640, height: 1000 }, deviceScaleFactor: 2 });
  try {
    await page.route("**/*", async (route): Promise<void> => route.abort());
    await page.setContent(html);
    const data = await page.locator("body").screenshot();
    return data.byteLength;
  } finally { await page.close(); }
}

const directory = join(process.cwd(), ".tmp", "report-layout-lab");
await mkdir(directory, { recursive: true });
const raw: unknown = JSON.parse(await readFile(join(directory, "live-data.json"), "utf8"));
const analysis = parseLabAnalyses(raw)[0];
if (analysis === undefined) throw new Error("Run the live layout collection before benchmarking.");
const html = renderReportImageHtml(analysis);
const cold: Sample[] = [];
const warm: Sample[] = [];
const executablePath = "C:/Program Files/Google/Chrome/Application/chrome.exe";

for (let i = 0; i < 5; i += 1) {
  const started = performance.now(); const cpu = process.cpuUsage();
  const browser = await chromium.launch({ executablePath, headless: true });
  const launched = performance.now();
  let rendered = launched;
  let bytes: number;
  try { bytes = await render(browser, html); rendered = performance.now(); } finally { await browser.close(); }
  const closed = performance.now();
  const delta = process.cpuUsage(cpu);
  cold.push({ wallMs: closed - started, nodeCpuMs: (delta.user + delta.system) / 1000, bytes, launchMs: launched - started, renderMs: rendered - launched, closeMs: closed - rendered });
}
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (let i = 0; i < 25; i += 1) {
    const started = performance.now(); const cpu = process.cpuUsage();
    const bytes = await render(browser, html); const delta = process.cpuUsage(cpu);
    warm.push({ wallMs: performance.now() - started, nodeCpuMs: (delta.user + delta.system) / 1000, bytes });
  }
} finally { await browser.close(); }

const result = {
  measuredAt: new Date().toISOString(), platform: process.platform,
  scope: "Local Chrome; rendering only. No scraper, Telegram upload, Vercel cold start or Chromium decompression. Node CPU excludes browser subprocess CPU; this is not Vercel billed CPU.",
  cold: { samples: cold.length, wallMs: statistics(cold.map(s => s.wallMs)), nodeCpuMs: statistics(cold.map(s => s.nodeCpuMs)), phasesMs: { launch: statistics(cold.map(s => s.launchMs ?? 0)), render: statistics(cold.map(s => s.renderMs ?? 0)), close: statistics(cold.map(s => s.closeMs ?? 0)) } },
  warm: { samples: warm.length, wallMs: statistics(warm.map(s => s.wallMs)), nodeCpuMs: statistics(warm.map(s => s.nodeCpuMs)) },
  imageBytes: statistics([...cold, ...warm].map(s => s.bytes)),
  samples: { cold, warm },
};
await writeFile(join(directory, "image-benchmark.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, samples: undefined }));
