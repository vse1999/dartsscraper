# DartsOrakel scraper and local Gemma research agent

Production-oriented TypeScript tooling for DartsOrakel player matches plus a bounded local Ollama/Gemma agent for natural-language darts research. The LLM only plans tool use and formats evidence; fixture discovery, player resolution, match scraping, and averages are deterministic.

## Setup

```bash
npm install
ollama pull gemma3:4b
npm test
npm run build
```

Ollama must be running at `http://127.0.0.1:11434`. Override the model with `OLLAMA_MODEL` or `--model`.

## Natural-language agent

One shot:

```bash
npm run agent -- "Keresd meg, kik játszanak a hétfői MODUS Super Series fordulóban, és számold ki minden játékos utolsó 10 meccsének átlagát."
npm run agent -- --debug --model gemma3:4b "Who plays MODUS on 2026-08-10? Show each player's last-10 average."
```

Interactive:

```bash
npm run agent
```

`--debug` writes structured tool calls, arguments, timing, and failure codes to stderr. It never prints hidden reasoning.

## Direct player CLI

```bash
npm run player -- "Damon Heta" 10
npm run player -- "Damon Heta" 10 --json
npm run player -- "Robert Thornton" 10
```

## Caching

- `.cache/dartsorakel`: long-lived player directory and five-minute match responses
- `.cache/modus`: six-hour fixture discovery results

Cache failures are non-fatal. Delete `.cache` manually only when intentionally forcing a complete live refresh.

## Documentation

- [Agent architecture](./docs/AGENT_ARCHITECTURE.md)
- [MODUS source investigation](./docs/MODUS_SOURCE_INVESTIGATION.md)
- [Tool contracts](./docs/TOOL_CONTRACTS.md)
- [DartsOrakel investigation](./INVESTIGATION.md)

The MODUS source chain reads the official public daily JSON first and falls back to the allowed public Darts Nerd season page. It does not bypass anti-bot controls or use private APIs.
