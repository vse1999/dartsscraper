import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  MODUS_RESULTS_URL,
  MODUS_RESULT_GROUPS,
  ModusResultsIndexSchema,
  type ModusMatchReference,
  type ModusResultGroup,
  type ModusSeriesDescriptor,
} from "../src/modus/history-schemas.js";
import { OfficialModusHistorySource } from "../src/modus/history-source.js";

const OUTPUT_PATH = path.resolve(process.cwd(), "data", "modus-results-index.json");
const source = new OfficialModusHistorySource({ timeoutMs: 15_000 });
const root = await source.getResultsPage();
const series: ModusSeriesDescriptor[] = [];
const references = new Map<string, ModusMatchReference>();

for (const descriptor of root.series) {
  const seriesPage = descriptor.id === root.selectedSeriesId
    ? root
    : await source.getResultsPage(descriptor.id, undefined, "Group A");
  const normalizedSeries: ModusSeriesDescriptor = {
    id: descriptor.id,
    name: descriptor.name,
    order: descriptor.order,
    weeks: seriesPage.weeks.map((week) => ({ ...week })),
  };
  series.push(normalizedSeries);
  for (const week of normalizedSeries.weeks) {
    const pages = await Promise.all(MODUS_RESULT_GROUPS.map(async (group: ModusResultGroup) => {
      const canReuse = seriesPage.selectedWeekId === week.id && seriesPage.selectedGroup === group;
      return canReuse ? seriesPage : source.getResultsPage(descriptor.id, week.id, group);
    }));
    for (const page of pages) {
      for (const reference of page.matches) references.set(reference.matchId, reference);
    }
    process.stderr.write(`Indexed ${descriptor.name} ${week.name}: ${references.size} unique matches\n`);
  }
}

const index = ModusResultsIndexSchema.parse({
  version: 1,
  generatedAt: new Date().toISOString(),
  sourceUrl: MODUS_RESULTS_URL,
  series,
  matches: [...references.values()].sort((left, right) => {
    return left.seriesOrder - right.seriesOrder
      || left.weekOrder - right.weekOrder
      || left.group.localeCompare(right.group)
      || left.matchNumber - right.matchNumber;
  }),
});

await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(index)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output: OUTPUT_PATH, series: index.series.length, weeks: index.series.reduce((sum, item) => sum + item.weeks.length, 0), matches: index.matches.length })}\n`);
