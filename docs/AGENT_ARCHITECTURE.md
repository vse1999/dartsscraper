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

The default `gemma4:12b` model uses Ollama native tool calling. `OllamaClient` retains a Zod-validated structured JSON action fallback for older models that reject the native `tools` field. Both modes expose the same tool semantics. No chain-of-thought or `thinking` field is requested, logged, or printed.

The browser chatbot adds a same-origin Node HTTP layer around one shared agent. `ChatSessionStore` retains at most 20 recent user/assistant messages per session, expires inactive sessions after six hours, and passes validated history into each run. `/api/health` verifies both Ollama and the selected model before chat work begins.

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
- one concurrent browser generation by default, with explicit HTTP 429 backpressure
- 4,000-character user messages, 16 KiB request bodies, session TTL/size limits, and browser cancellation
- local binding, same-origin API checks, restrictive CSP, and plain-text answer rendering

The current workflow intentionally supports one target date per research query. Multi-date comparative research should be added as a separate explicit workflow rather than guessed.
