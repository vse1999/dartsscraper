# DartsOrakel player match scraper

Production-oriented TypeScript scraper for the public DartsOrakel player stats and match APIs. It resolves a player by normalized name, validates the API responses with Zod, returns the latest completed matches, and calculates the mean of available per-match three-dart averages.

## Setup

```bash
npm install
npm test
npm run build
```

## CLI

```bash
npm run player -- "Damon Heta" 10
npm run player -- "Damon Heta" 10 --json
npm run player -- "Robert Thornton" 10
```

The CLI uses `.cache/dartsorakel` for optional local caching. Player identity responses use a long TTL; match responses use a five-minute TTL. Cache failures are non-fatal.

## Library

```ts
import { calculateMatchAverage, getLastMatches, resolvePlayer } from "./src/index.js";

const player = await resolvePlayer(" Damon   HETA ");
const result = await getLastMatches("Damon Heta", 10);
const mean = calculateMatchAverage(result.matches);
```

The scraper does not use an LLM for extraction. See [INVESTIGATION.md](./INVESTIGATION.md) for the live-site findings and exact API contract.

