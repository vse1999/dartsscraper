# Local Gemma darts research agent

## Architecture

The LLM is an orchestrator, not a data extractor or calculator.

1. `DartsResearchAgent` receives natural-language English or Hungarian.
2. `resolveResearchDate` deterministically resolves ISO dates, today/tomorrow (`ma`/`holnap`), and weekdays such as `Monday`/`hétfői` in `Europe/Budapest`.
3. `getModusPlayers` uses source priority and cache to discover the scheduled field.
4. Player tools call the existing DartsOrakel service. `getPlayerMatchAverage` uses the existing deterministic arithmetic mean.
5. Gemma formats the evidence. A validator requires every discovered player, exact tool-produced averages, and the ISO date. After two invalid drafts, a deterministic formatter returns a safe answer rather than exposing fabricated data.

```text
Natural language -> Gemma planner -> validated tool calls -> deterministic sources/services
                                <- structured results <-
                 -> evidence-validated Gemma answer (safe formatter fallback)
```

## Model protocol

Ollama native tool calling is used when the selected model supports it. Ollama's current `gemma3:4b` model reports that native tools are unsupported, so `OllamaClient` automatically switches to a Zod-validated structured JSON action protocol. Both modes expose the same tool semantics. No chain-of-thought or `thinking` field is requested, logged, or printed.

## Safety and bounds

- 20 maximum model iterations
- 32 maximum tool executions
- 180-second overall deadline and 90-second Ollama request timeout
- concurrency limit 3 for independent player calls
- strict Zod validation at source, tool argument, Ollama response, and JSON-action boundaries
- relative-date guard overrides a model-supplied wrong fixture date
- MODUS average guard permits only players returned by `getModusPlayers`
- player failures are returned as per-player structured failures
- debug logging includes tool names, arguments, timing, success, and error code; it never prints model thinking

The current workflow intentionally supports one target date per research query. Multi-date comparative research should be added as a separate explicit workflow rather than guessed.
