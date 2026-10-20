# AI assistant, Hermes Agent, and automation analysis

**Date:** 2026-10-14
**Scope:** Whole-app product/architecture review, with emphasis on the local assistant, scheduled work, and a safe Hermes integration. This is a recommendation, not authorization to install software, add schedules, change credentials, contact Telegram, or deploy.

## Executive decision

This app already has a capable, evidence-oriented AI assistant: the local browser app routes supported factual questions through deterministic code first, then uses Ollama/Gemma for open-ended research. It also has a separate owner-only Telegram bot and a daily MODUS report. Hermes would add value as an **optional operator/assistant shell**—persistent conversations, reusable skills, multiple channels, and a scheduler—not as a replacement for the app's parsers, statistics, identity rules, source controls, or report jobs.

Recommended direction:

1. Keep the TypeScript application as the system of record for darts data and arithmetic.
2. First try Hermes manually against the existing local Ollama endpoint; do not change the app or its Telegram bot.
3. If useful, add a small, read-only MCP bridge that calls the app's existing typed services. Give Hermes only an explicit allowlist of darts-research tools—no shell, arbitrary URL/file access, odds actions, or Telegram send tool.
4. Keep the existing Vercel daily MODUS schedule. Do not duplicate it in Hermes. Treat new event monitoring and proactive PDC delivery as future work until persistent state, provider capacity, and recovery needs are demonstrated.
5. Prioritize evidence-backed comparisons and fixture-aware research over a larger model, prediction claims, or a general-purpose autonomous agent.

## What the app is today

The repository contains several products sharing validated data services:

| Surface | Current job | Important boundary |
|---|---|---|
| Player CLI and local agent CLI | Direct player research; one-shot/interactive model tool loop | Local Node.js process, source requests, and local cache. |
| Local browser chatbot | Same-origin Node HTTP app, browser transcript, local Ollama/Gemma | Deterministic fast answers for supported player/MODUS/PDC intents; otherwise a bounded tool-using agent. Backend chat history is process memory (six-hour TTL); the browser keeps a bounded transcript in `localStorage`. |
| Private Telegram bot | Player history, compare/value/odds, MODUS/PDC reports | Owner/private-chat authorization and deterministic TypeScript workflows; Telegram does not use the Gemma agent. |
| Research tooling | Quality/coverage analysis, fixture inventories, local evidence/checkpoints, replay, feedback, benchmarks | Retention/collection is explicitly enabled and invoked locally; this is not a hosted continuous collector. |
| Watchlist package | Offline screening, quota policy, preview, and replay components | Its roadmap/status docs say the live source/runtime, durable storage, scheduler, and alert delivery are not implemented. It is not an active autonomous betting/alert service. |

The source/data layer is the app's strongest foundation. DartsOrakel history and official MODUS/PDC sources have distinct adapters; player identity, parsing, metric correlation, calculations, freshness/coverage, and source URLs are intended to be deterministic. The assistant currently exposes six model tools (`resolveDate`, MODUS players/results, PDC results, player matches, and player averages); Zod validates their arguments/results. `FastResearchService` skips the model for recognized factual queries. The harness bounds model/tool work and has deterministic fallbacks for selected answer shapes, but generic open-ended prose does not have universal claim-by-claim proof validation.

The production/operations model is intentionally modest: Node/TypeScript on Vercel for webhook/report functions; `vercel.json` schedules the daily MODUS endpoint at 17:00 UTC. PDC reports are on-demand and split into bounded work. The current PDC job receipt adapter is in-memory and warm-process scoped; it is not a durable queue or global duplicate guard. The research CLI and watchlist replay do not activate a scheduled live pipeline. There is no shared production database, cross-instance quota reservation, durable report ledger, or general push-alert engine.

**User value already present:** trusted latest-match facts, sourced current MODUS/PDC results, player summaries, compare/value/odds reports, and bounded scheduled MODUS reports. The main gap is not “add AI”; it is to make the assistant better at joining and explaining already available evidence without implying more certainty or automation reliability than exists.

## Hermes fit

Hermes Agent is an external, open-source agent runtime with CLI/desktop/gateway surfaces, MCP integrations, reusable skills/memory, and cron. Its documentation describes native Windows installation, local custom OpenAI-compatible endpoints (including Ollama), MCP over stdio/HTTP, and scheduled jobs that can either invoke the model or run a script-only “no-agent” check. See [Hermes overview](https://hermes-agent.nousresearch.com/docs/), [custom/local model providers](https://hermes-agent.nousresearch.com/docs/integrations/providers), [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp), and [scheduled tasks](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron).

### Good fit

- **Operator copilot:** ask follow-up questions over approved app tools; keep durable operator context/skills outside the app's current six-hour in-memory chat session.
- **Composable research:** a `darts-evidence` skill can teach metric definitions, source precedence, Budapest date conventions, required citations, and “unknown is not zero.” The skill can improve consistency, but it cannot certify source truth.
- **Read-only MCP:** Hermes can call a narrow Node MCP server over stdio and use the app's existing validated services instead of scraping pages itself. Hermes supports per-server tool inclusion, so the configured tools can be allowlisted.
- **Automation orchestration:** use Hermes cron for a user-owned event-day briefing or operator notification after a typed read path exists. Use a no-agent script for deterministic threshold/health checks; reserve model generation for concise explanations of a changed, structured result.
- **Local model reuse:** Hermes supports custom OpenAI-compatible endpoints; connecting it to local Ollama may avoid sending prompts to a cloud inference provider. Test the selected model's tool-call behavior and context/performance locally before relying on it.

### Poor fit / avoid

- Do not replace the current business logic or put Hermes inside Vercel functions. The existing application has short-lived, deadline-bounded serverless requests; Hermes' gateway/cron is a long-running agent runtime with its own process/config/state.
- Do not let Hermes browse, scrape, calculate, or decide player identity when the TypeScript service already owns those contracts. No unrestricted shell, browser, or filesystem is needed for a darts research assistant.
- Do not wire Hermes to the existing Telegram bot token. This app registers its own Telegram webhook; a second gateway on that token would compete for the same bot/update delivery configuration. Use local Desktop/CLI first, or a separately authorized bot/account later.
- Do not assume “local model” means the whole workflow stays private: the research tools still contact public data sources, and a cloud Hermes model would receive prompt/tool context. The provider and any networked tools must be chosen deliberately.
- Do not treat Hermes memory or self-improving skills as an evidence ledger, source freshness guarantee, or prediction validation. Durable preferences and durable source evidence are different data products.

Because Hermes is a general-purpose agent, apply its security controls conservatively: explicit user allowlists, no allow-all gateway, minimal enabled tools, and isolation/approval for terminal actions. Hermes documents default-deny gateway authorization and terminal/container security choices in its [security guide](https://hermes-agent.nousresearch.com/docs/user-guide/security). For this use case, the safer design is to omit terminal/file tools from the assistant profile rather than rely on approval prompts to protect application secrets.

## Highest-value implementation opportunities

Effort and value below are relative hypotheses, not measured ROI.

| Priority | Implementation | Why it is valuable here | Acceptance gate |
|---|---|---|---|
| **P1 — very high** | **One deterministic `comparePlayers` / matchup-analysis tool** that accepts two resolved players and a validated window, reuses the existing comparison/statistics code, and returns a single structured comparison. | The app already has compare workflows, disjoint recent/prior windows, weighted finishing evidence, coverage, and trend checks. The local LLM should not have to reconstruct a comparison from multiple separately fetched histories. It would make follow-ups like “what is the strongest evidence against that?” safer and faster. | Same scope/period for both players; explicit row counts and missingness; source/provenance per input; no forecast or “value” score; parity tests against existing deterministic reports. |
| **P1 — very high** | **Fixture-aware assistant tool** for upcoming MODUS/PDC schedule, returning confirmed named fixtures separately from pending/unavailable coverage. | The app has rich fixture adapters and PDC command flows, but the agent's tool surface does not include one common upcoming-fixture contract. Users should be able to ask “who plays tomorrow?” and continue into form research without the LLM inferring a draw. | Reuse current source adapters; preserve provider/source and status; enforce Budapest dates; never turn partial discovery into an empty slate; do not fetch player histories for placeholders. |
| **P1 — high** | **Evidence-first answer cards and source/freshness display** shared between local assistant and Telegram formats. | The local fast path returns freshness metadata, while the model path relies more heavily on tool prose and specialized validators. A user-facing evidence block—source links, fetched/observed time, stale flag, requested/returned rows, metric coverage, and limitations—makes all answer modes inspectable. | Numeric claims render from typed evidence; no unsupported source/freshness inference; errors/partial data remain explicit; browser renders safe text/links. |
| **P2 — high** | **Saved research/watchlists plus explicit owner feedback** using the local evidence/feedback foundations. | Repeated manual research is a clear time-saver opportunity. An opt-in list of players/events and “useful / incorrect / missing data” feedback can improve the user experience before any prediction system exists. | Start local/opt-in; preserve evidence time/version and user intent; no surprise notifications; add shared cloud storage only if the pilot shows a real cross-instance need. |
| **P2 — conditional** | **Event-day briefing automation** after fixture and compare tools exist. | A user-requested brief over verified fixtures can reduce repeated manual lookups. A script should produce the structured evidence; Hermes can shorten/explain it. | Shadow/local first; one bounded run per relevant event/day; suppress unchanged output; clear partial status; measure time saved and bad/ignored alerts before delivery. |
| **P3 — defer** | Odds history, calibrated probabilities, rankings, or betting suggestions. | Current `/odds` is a read-only visible-price lookup and `/value` is descriptive, with no archived quotes or validated probabilities. Existing watchlist plans say the autonomous live pipeline is not complete. | Point-in-time evidence, market identity, source permissions, time-aware backtests, calibration/uncertainty, subgroup checks, and a shadow period must precede claims. An LLM must never invent win probability or betting edge. |

The highest-priority product slice is therefore **verified fixture → comparable player evidence → concise, source-linked explanation**, not a larger model. This aligns with the existing [research roadmap](./RESEARCH_BOT_ROADMAP_2026-10-05.md); the recent research quality/coverage package already supplies useful contracts to reuse.

## Recommended integration shape

```text
Hermes (optional UI, memory, skills, cron)
    └── allowlisted read-only MCP calls (stdio, local process)
          └── darts MCP adapter in Node/TypeScript
                └── existing typed application services/adapters
                      └── validated public-source evidence
```

Keep the MCP server in the repository/runtime boundary so it can construct the same clients/services as `createDartsResearchRuntime`. Do not expose a generic `fetch(url)`, “run a command”, raw cache path, arbitrary player ID, or production-send method. Start with a small tool list such as:

- `get_upcoming_fixtures(source, date)`
- `get_player_history(player, limit)` with a conservative cap (for example 20)
- `compare_players(player_a, player_b, window)` for deterministic summaries
- `get_official_results(source, date)`
- `get_source_status()` for a sanitized health/status snapshot, if one can be defined without triggering a full report

Each output should be a bounded, Zod-validated record with `source`, proof URLs, canonical identities, observation time, any published source-update time, stale/partial status, requested/returned scope, metric coverage, and failure reason codes. If an existing service cannot provide one of these fields, return “unknown” rather than manufacture it. Disable MCP resource/prompt wrappers unless the app later needs them, and configure Hermes with an explicit `tools.include` list for the darts server. Initially keep this MCP local-only; remote access would require authentication, authorization, network controls, and a threat review.

## Automation proposal

### Keep as-is

- Keep the existing Vercel cron for the daily MODUS report as the single production schedule for that workflow.
- Keep PDC work on-demand while the current no-database pilot is being evaluated. The PDC documentation explicitly says the in-memory receipt store is not durable, the owner may need to repeat a stopped job, and prefetch should be revisited only after measured product need and a durable admission/recovery design.
- Keep `npm run verify:research`/CI as the code verification automation. Hermes should not replace CI or silently run production commands.

### Safe staged use of Hermes cron

1. **Manual proof first:** connect Hermes to a local Ollama custom endpoint and ask it to summarize one tool result. Do not add gateway or cron yet. Hermes documents Ollama through its custom OpenAI-compatible endpoint; verify the exact model, tool calling, prompt size, latency, RAM, and that cloud fallback is off.
2. **Read-only MCP spike:** expose a few validated tools over local stdio. Test malformed inputs, ambiguous player names, source outage, stale/partial results, cancellation, oversized output, and that unauthorized tools are not present.
3. **Local scheduled preview:** once fixture and compare tools work, schedule a private event-day “brief” to Hermes' local/origin session. Start in preview/no-delivery mode; avoid the existing app Telegram bot. Keep the schedule no more frequent than the source freshness and request allowance justify.
4. **Automate deterministic checks without an LLM:** Hermes cron supports no-agent scripts whose stdout is delivered verbatim and empty output suppresses the notification. A future script-only source-health or “new validated result exists” check is preferable to asking an LLM to decide whether a source changed. The script needs its own bounded state/input contract; current in-memory caches are not sufficient for cross-run change detection.
5. **Only then consider delivery:** if the user confirms a destination, use a separate Hermes bot/token or a deliberate application delivery integration. Add durable admission/delivery state, idempotency, rate control, explicit uncertain-send behavior, opt-out, and rollback first. Do not reuse the existing owner bot token.

Hermes cron is attached to a running Hermes gateway/host. A local Windows schedule is therefore unavailable while the PC sleeps or the gateway is stopped; it is not a substitute for an always-on production scheduler. A VPS/container or hosted deployment would be a separate operations/security decision, not something to place inside a Vercel function.

## Main risks and controls

- **Unsupported narrative / hallucination:** keep retrieval and math deterministic; structured evidence then model wording; show source and limitations; do not treat assistant prose as evidence in follow-ups.
- **Prompt injection from source text:** public pages and tool results are untrusted. Parse/validate in TypeScript; do not let page text grant tools or alter source policy.
- **Credential/tool overreach:** no app secrets in Hermes profiles or MCP results; no shell, file, browser, write, or send tools in the initial assistant profile; use explicit allowlists.
- **Same-bot conflict:** existing app webhook owns the current Telegram bot token; separate credentials if a Hermes messaging gateway is ever approved.
- **False durability:** process memory, warm Vercel caches, local checkpoints, and Hermes cron job files are not a distributed application job queue or shared quota ledger.
- **Quota amplification:** a natural-language agent may call several tools or retry. Bound dates, players, match counts, calls, concurrency, wall time, and response bytes in the MCP server, not just in prompts.
- **Cloud-model privacy/cost:** using a cloud inference provider sends query and tool context to that provider; use local Ollama if privacy/free inference is a requirement, then measure hardware/latency.
- **Prediction/betting risk:** remain descriptive until a point-in-time evidence archive and honest walk-forward evaluation demonstrate value; separate missing data, confidence in inputs, and uncertainty in any future model.

## Suggested success metrics

Before any proactive rollout, baseline and then measure: fraction of queries completed without correction; identity/source error rate; completeness of requested versus returned rows; stale/partial rate; p50/p95 source latency on representative slates; tool/source calls per answer; user-reported usefulness/time saved; duplicate/uncertain delivery count; and opt-out/ignored-brief rate. A ten-report trial is directional, not a reliable SLO or predictive-performance claim. The PDC no-database MVP already suggests a useful first ten owner-initiated reports for reviewing preview time, complete pairings, partial outcomes, and delivery uncertainty.

## Review and verification notes

- Reviewed the repository map, README/manual/docs, TypeScript composition, local chat/agent/tools, research workflow, Telegram/Vercel schedules, PDC no-database architecture, and offline watchlist boundaries. This is a strategic and architecture audit, not a source-by-source correctness certification or live provider/production audit.
- The worktree already contained uncommitted PDC/report/cache changes and docs. They were preserved; this analysis adds only this Markdown file.
- `npm run build` passed.
- `npm test` passed: **872 tests across 90 files**. The first run hit a Windows sandbox `EPERM` on atomic rename under the OS temp directory. Re-running with `TEMP`/`TMP` directed to the repository's ignored `.tmp` directory passed; no application code or test was changed.
- The full live source/Telegram smoke suite, production audit, Vercel deployment, and Hermes installation/setup were not run.

## Primary Hermes references

- [Hermes Agent documentation and platform overview](https://hermes-agent.nousresearch.com/docs/)
- [Provider setup and custom/local Ollama endpoints](https://hermes-agent.nousresearch.com/docs/integrations/providers)
- [MCP transports, per-server tool filters, and runtime behavior](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)
- [Scheduled cron jobs and script-only no-agent jobs](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)
- [Security, authorization, approvals, and isolation](https://hermes-agent.nousresearch.com/docs/user-guide/security)
