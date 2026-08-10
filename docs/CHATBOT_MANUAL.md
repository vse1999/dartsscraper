# Darts chatbot manual: Ollama + Gemma + deterministic tools

This document explains the current local browser chatbot, how its Ollama/Gemma agent works, how to operate it, and how to extend it into a broader darts research assistant instead of a single hardcoded scraping workflow.

## 1. What the application is

The application has three separate responsibilities:

1. **Gemma understands the request and chooses actions.**
2. **TypeScript tools fetch or calculate facts.**
3. **The agent loop returns tool results to Gemma and validates the final answer.**

Gemma is not trusted to invent fixture data, match data, player names, dates, or averages. It decides what information it needs, but deterministic code obtains the information.

```text
User / chatbot
      |
      v
Gemma planner and answer writer
      |
      | validated tool calls
      v
Tool registry and scheduler
      |
      +--> MODUS fixture sources
      +--> DartsOrakel player resolver
      +--> DartsOrakel match scraper
      +--> deterministic statistics
      |
      v
Structured evidence with source and errors
      |
      v
Gemma answer draft -> evidence validator -> user
```

This division is important. An LLM is useful for language, intent recognition, tool selection, follow-up questions, and explanation. Normal code is more reliable for HTTP requests, parsing, arithmetic, validation, caching, timeouts, and retries.

## 2. What works now

The current agent can:

- understand English and Hungarian requests;
- resolve explicit dates and common relative dates;
- find MODUS Super Series participants for a date;
- resolve fixture-provider names to DartsOrakel players;
- retrieve a player's latest completed matches;
- calculate an arithmetic mean over the latest matches;
- execute independent player calls with controlled concurrency;
- keep successful results when another player fails;
- prevent a model from replacing discovered MODUS players with invented names;
- validate that a MODUS-average answer contains the requested date, players, and exact calculated values;
- use a deterministic answer formatter if Gemma repeatedly produces an unsupported final draft.
- serve a responsive local browser chatbot at `http://127.0.0.1:3210`;
- verify that Ollama and the configured model are ready before accepting a prompt;
- retain bounded multi-turn history for pronouns and follow-up questions;
- cancel browser requests and reject concurrent generations with backpressure;
- render all model output as safe plain text under a restrictive Content Security Policy.

The available tools are:

| Tool | Purpose |
|---|---|
| `resolveDate` | Convert a date expression into an ISO date. |
| `getModusPlayers` | Discover confirmed MODUS players for a date. |
| `getPlayerMatches` | Return validated match rows and their deterministic mean. |
| `getPlayerMatchAverage` | Return a compact last-N average result. |

The current agent is still a **specialized darts research agent**, not an unrestricted web assistant. In particular:

- history contains final user/assistant turns, not persisted raw tool payloads;
- the strongest evidence guard is specialized for MODUS-average questions;
- no tool currently provides rankings, arbitrary tournament fields, head-to-head summaries, form trends, or general web search;
- Gemma can reason only over facts that an available tool returns.

These are extension points, not reasons to let Gemma guess.

## 3. Important files

| File | Responsibility |
|---|---|
| `src/agent-cli.ts` | One-shot and interactive terminal interface. |
| `src/agent/factory.ts` | Builds clients, caches, sources, tools, and the agent. |
| `src/agent/harness.ts` | Agent loop, limits, scheduling, evidence collection, and answer validation. |
| `src/agent/ollama-client.ts` | Ollama `/api/chat` client and Gemma JSON-action fallback. |
| `src/agent/tools.ts` | Tool definitions, Zod argument validation, and dispatch. |
| `src/agent/date.ts` | Deterministic English/Hungarian date resolution. |
| `src/chat-server.ts` | Validates environment configuration and starts the local server. |
| `src/chat/server.ts` | Same-origin API, security headers, static UI, limits, and cancellation. |
| `src/chat/session-store.ts` | Bounded in-memory multi-turn session history with TTL and LRU eviction. |
| `src/chat/ollama-health.ts` | Checks Ollama version, availability, and configured model installation. |
| `public/*` | Responsive browser chat interface. |
| `src/modus/*` | Official and fallback MODUS fixture discovery. |
| `src/dartsorakel/*` | DartsOrakel HTTP client, parsing, and scraping. |
| `src/services/*` | Player-match orchestration and statistics. |
| `src/cache.ts` | Optional filesystem cache. |

See also:

- `docs/AGENT_ARCHITECTURE.md`
- `docs/TOOL_CONTRACTS.md`
- `docs/MODUS_SOURCE_INVESTIGATION.md`

## 4. Install and start

### Requirements

- Node.js 18 or newer;
- npm;
- Ollama;
- enough memory for the selected Gemma model;
- internet access for the public darts sources.

### Install dependencies

```bash
npm install
npm run build
npm test
```

### Install Gemma 4

The application default is Gemma 4 12B. It supports Ollama native tools and requires a current Ollama release:

```bash
ollama pull gemma4:12b
```

Confirm that Ollama is reachable:

```bash
curl http://127.0.0.1:11434/api/tags
```

On Windows PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:11434/api/tags
```

### Start the browser chatbot

```bash
npm run chat
```

Open `http://127.0.0.1:3210`. The green **Ollama ready** badge confirms that both Ollama and `gemma4:12b` are available.

### Select a different model

For one command:

```bash
npm run agent -- --model gemma4:12b "Show Rob Cross's last 10 matches."
```

For the current shell:

```powershell
$env:OLLAMA_MODEL = "gemma4:12b"
npm run chat
```

The fallback default is `gemma4:12b`.

## 5. Use the existing agent

### One-shot request

```bash
npm run agent -- "Keresd meg a mai MODUS játékosokat, és mutasd az utolsó 10 meccsük átlagát."
```

```bash
npm run agent -- "Show Rob Cross's last 5 completed matches."
```

### Interactive terminal

```bash
npm run agent
```

Then enter a question at the prompt:

```text
darts> Who plays MODUS today and what is each player's last-10 average?
```

Enter `exit` or `quit` to close it.

Important: the current interactive mode is a convenient repeated-query interface. Each query is processed independently; pronouns such as “him”, “those players”, or “compare them” are not guaranteed to refer to the previous terminal answer.

### Debug mode

```bash
npm run agent -- --debug "Who plays MODUS today?"
```

Debug output goes to stderr and includes:

- selected tool;
- validated arguments;
- duration;
- success/failure;
- structured error code.

It does not expose model chain-of-thought.

### Direct deterministic player CLI

Use this to test the scraper without Gemma:

```bash
npm run player -- "Rob Cross" 10
npm run player -- "Rob Cross" 10 --json
```

If the deterministic CLI fails, fix the source/resolver/scraper before debugging the model.

## 6. How one request is processed

For this question:

```text
Who plays MODUS on Monday, and what is each player's last-10 average?
```

The current sequence is:

1. The agent normalizes the request and deterministically resolves Monday in `Europe/Budapest`.
2. Gemma requests `getModusPlayers`.
3. The date guard ensures that the fixture call uses the deterministic ISO date.
4. The MODUS service checks its cache.
5. The service tries the official daily feed, then the allowed public fallback page.
6. Fixture names are normalized and resolved against DartsOrakel.
7. The agent records the returned player list as evidence.
8. The agent executes one compact average operation per discovered player, up to three concurrently.
9. Each operation resolves the player, retrieves completed matches, and calculates the mean in TypeScript.
10. Tool results are added to the model conversation.
11. Gemma writes a user-facing answer.
12. The evidence validator verifies the date, every player, and every available numeric result.
13. An invalid draft is returned to Gemma for repair. A second invalid draft activates the deterministic safe formatter.

The model therefore participates in understanding, planning, and explanation, while the data remains verifiable.

## 7. Ollama and Gemma protocol

Ollama exposes chat through:

```text
POST http://127.0.0.1:11434/api/chat
```

The request contains:

- `model`;
- conversation `messages`;
- tool definitions when the model supports native tools;
- `stream: false` in the current implementation;
- `think: false`;
- `temperature: 0`;
- a JSON schema in `format` when using the Gemma fallback protocol.

### Native tool mode

A tool-capable model returns calls such as:

```json
{
  "message": {
    "role": "assistant",
    "tool_calls": [
      {
        "function": {
          "name": "getPlayerMatchAverage",
          "arguments": {
            "player": "Rob Cross",
            "limit": 10
          }
        }
      }
    ]
  }
}
```

The application validates the function name and arguments, executes the tool, appends a tool-result message, and calls the model again.

### Gemma JSON-action mode

Older models may reject Ollama's native `tools` field. The client detects that response and automatically switches to structured JSON actions:

```json
{
  "action": "tools",
  "calls": [
    {
      "name": "getPlayerMatchAverage",
      "arguments": {
        "player": "Rob Cross",
        "limit": 10
      }
    }
  ],
  "answer": ""
}
```

After receiving tool results, Gemma finishes with:

```json
{
  "action": "final",
  "calls": [],
  "answer": "Rob Cross's last-10 average is ..."
}
```

The response is constrained by an Ollama JSON schema and then parsed again with Zod. This lets Gemma perform multi-step work even without native tool metadata.

### Which Gemma model to use

- `gemma4:12b`: project default; native tool support and strong instruction following for this agent workflow.
- Older or smaller local models can be selected explicitly, but may use the JSON-action fallback and need more answer repair.

Model size does not replace validation. Keep the same tool and evidence boundaries for every model.

## 8. Browser chatbot and API

A chatbot needs two parts:

1. a backend that owns Ollama, the agent, tools, limits, and sessions;
2. a UI that sends messages and displays answers.

Do not call Ollama directly from a public browser. That would expose the local endpoint, remove server-side validation, and let clients bypass tool policies.

### Implemented API contract

Request:

```json
{
  "sessionId": "8d28f9be-...",
  "message": "Compare Rob Cross and Gerwyn Price over their last 20 matches."
}
```

Response:

```json
{
  "sessionId": "8d28f9be-...",
  "answer": "...",
  "model": "gemma4:12b",
  "metrics": {
    "iterations": 3,
    "toolCalls": 2
  }
}
```

The server validates this request with Zod, limits messages to 4,000 characters and bodies to 16 KiB, and rejects empty or cross-origin input. Additional routes are `GET /api/health` and `DELETE /api/sessions/:sessionId`.

### Library integration

The current library can already be called from another TypeScript service:

```ts
import { z } from "zod";

import { createDartsResearchAgent } from "./src/agent/factory.js";

const ChatRequestSchema = z.object({
  sessionId: z.string().uuid(),
  message: z.string().trim().min(1).max(4_000),
}).strict();

export interface ChatResponse {
  sessionId: string;
  answer: string;
  model: string;
  iterations: number;
  toolCalls: number;
}

const agent = createDartsResearchAgent({ model: "gemma4:12b" });

export async function handleChatRequest(input: unknown): Promise<ChatResponse> {
  const request = ChatRequestSchema.parse(input);
  const result = await agent.run(request.message, { history: [] });
  return {
    sessionId: request.sessionId,
    answer: result.answer,
    model: result.model,
    iterations: result.iterations,
    toolCalls: result.toolCalls,
  };
}
```

The included `src/chat/server.ts` already implements this boundary with Node's HTTP server and keeps one agent instance alive so caches and Ollama mode detection are reused.

### Frontend behavior

The chatbot UI should:

- submit one user message at a time;
- disable duplicate submission while the request is running;
- display a visible “researching” state;
- render Markdown tables safely;
- distinguish complete, partial, and failed answers;
- offer a debug panel only to trusted local users;
- show source links returned by the backend;
- allow cancellation through an `AbortSignal`.

For the first chatbot version, non-streaming responses are simpler and match the existing client. Add streaming only after tool-call and cancellation behavior are covered by tests.

## 9. Conversation memory

`run(query, { history, signal })` accepts validated prior turns. The browser backend owns a `ChatSessionStore` that retains complete user/assistant exchanges, limits each session to 20 messages and 32,000 characters, expires inactive sessions after six hours, and evicts least-recently-used sessions above 100.

### Public shape

Change the public API conceptually to:

```ts
export interface AgentConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentRunOptions {
  history?: readonly AgentConversationMessage[];
  signal?: AbortSignal;
}

public async run(query: string, options?: AgentRunOptions): Promise<AgentRunResult>
```

The backend owns a synchronous local `ChatSessionStore` with these operations:

```ts
export class ChatSessionStore {
  getHistory(sessionId: string): readonly AgentConversationMessage[];
  appendExchange(sessionId: string, userContent: string, assistantContent: string): void;
  delete(sessionId: string): boolean;
}
```

For a local single-user app, an in-memory store is enough initially. For a persistent service, use SQLite or Postgres with a session TTL.

### What to store

Store:

- user messages;
- final assistant answers;
- compact structured evidence summaries;
- selected entities such as player names and dates.

Do not permanently store:

- hidden model reasoning;
- complete raw source pages;
- secrets or authorization headers;
- unlimited historical tool payloads.

### Context compaction

Long chats eventually exceed useful context. Keep recent turns and a validated summary such as:

```json
{
  "activePlayers": ["Rob Cross", "Gerwyn Price"],
  "activeDate": "2026-08-10",
  "lastRequestedLimit": 20,
  "answeredTopics": ["last-match averages"]
}
```

Gemma may use this state for pronoun resolution, but a deterministic entity resolver should verify names before calling data tools.

## 10. Make Gemma solve more than one hardcoded workflow

The current implementation has a deliberate MODUS safety workflow in `src/agent/harness.ts`. It detects `modus` and average-related language so it can enforce the discovered player set. That is useful protection, but generalization should not become a growing list of phrase checks.

The target design is a **generic tool registry plus reusable policy modules**.

### Step 1: introduce a typed tool registry

Each tool should own:

- name;
- description;
- JSON input schema;
- Zod input schema;
- Zod output schema;
- handler;
- timeout;
- cache policy;
- concurrency group;
- source/provenance policy.

Conceptual interface:

```ts
import type { z } from "zod";

export interface RegisteredTool<TInput, TOutput> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  execute(input: TInput, signal: AbortSignal): Promise<TOutput>;
}
```

The dispatcher should look up a tool by name, validate its input, execute it, validate its output, and return a standard envelope. Tool-specific `switch` branches can then be replaced with registry entries.

### Step 2: add a generic agent action schema

Extend the structured protocol to support an honest inability response:

```json
{
  "action": "cannot_answer",
  "calls": [],
  "answer": "",
  "missingCapabilities": ["No head-to-head tool is installed."]
}
```

Recommended actions:

- `tools`: request one or more tool operations;
- `final`: answer from collected evidence;
- `clarify`: ask one short question when essential input is missing;
- `cannot_answer`: explain which capability or source is unavailable.

Gemma should never use `final` for a factual darts claim that lacks evidence.

### Step 3: add compact bulk tools

The current harness expands a discovered field into player-average calls as a safety guard. A more general interface is a deterministic bulk tool:

```json
{
  "name": "getPlayersMatchAverages",
  "arguments": {
    "players": ["Ryan Branley", "Jack Drayton"],
    "limit": 10,
    "concurrency": 3
  }
}
```

The bulk tool should:

- validate and deduplicate names;
- resolve every player;
- use controlled concurrency;
- return one result or error per input player;
- preserve input order;
- calculate every mean in TypeScript;
- attach actual match count and source timestamps.

Then Gemma can perform the general sequence:

1. discover a list;
2. pass the returned list to a bulk statistics tool;
3. explain the results.

This removes phrase-specific player-call expansion from the central loop.

### Step 4: add domain tools, not prompt hacks

To support more darts questions, implement tools such as:

| Proposed tool | Questions enabled |
|---|---|
| `searchPlayers` | “Is there a player named Williams?” |
| `getPlayerProfile` | “Who is this player?” |
| `getPlayerMatches` | “Show the last five matches.” |
| `getPlayersMatchAverages` | “Compare these six players over 20 matches.” |
| `getPlayerFormTrend` | “Is Rob Cross improving?” |
| `getHeadToHead` | “How has Cross performed against Price?” |
| `getTournamentFixtures` | “Who plays in this event tomorrow?” |
| `getTournamentResults` | “Who reached the final last week?” |
| `getRankings` | “Who is highest ranked?” |
| `comparePlayers` | Multi-metric deterministic comparison. |
| `explainStatistic` | Definition and methodology, backed by local documentation. |

Every numeric conclusion should be produced by a deterministic tool. Gemma can select metrics and explain their meaning.

### Step 5: include provenance in every result

Use a shared metadata object:

```json
{
  "data": {},
  "provenance": {
    "source": "DartsOrakel",
    "url": "https://dartsorakel.com/...",
    "retrievedAt": "2026-08-10T10:15:00Z",
    "cacheHit": false
  },
  "warnings": []
}
```

The final answer can then cite sources without relying on the model to remember where a value came from.

### Step 6: use generic evidence validation

Replace a single MODUS-average validator with validators derived from the tool outputs and requested task.

Examples:

- a comparison answer must mention every requested player;
- a last-N answer must report the actual sample size;
- a ranking answer must preserve the tool's order;
- an average in prose must exactly match a returned numeric value;
- unavailable data must not be converted into zero;
- every factual section must reference at least one provenance record.

A safe deterministic renderer should exist for each high-value structured result type.

## 11. Recommended system prompt

A general darts-agent prompt should be concise and enforce evidence use:

```text
You are a local darts research assistant.

Use tools for all current, historical, player, fixture, match, ranking, and numeric facts.
Never invent a player, event, date, match, source, or statistic.
Never perform arithmetic yourself when a deterministic statistics tool exists.
Call independent tools in parallel when their inputs are already known.
If a required argument is missing, ask one concise clarification question.
If no available tool can answer the question, state the missing capability.
Preserve partial failures and actual sample sizes.
Answer in the user's language.
Cite the source metadata supplied by tools.
Do not reveal hidden reasoning. Return only tool actions or the final answer.
```

Do not place source-specific parsing instructions in the system prompt. Parsing belongs in source adapters and tests.

## 12. Example questions and required tool paths

### Existing capability: one player

Question:

```text
Show Rob Cross's last five completed matches and his mean average.
```

Path:

```text
getPlayerMatches({ player: "Rob Cross", limit: 5 }) -> final
```

### Existing capability: MODUS field

Question:

```text
Kik játszanak ma a MODUS-ban, és mennyi az utolsó 20 meccsük átlaga?
```

Path:

```text
resolveDate -> getModusPlayers -> getPlayersMatchAverages -> final
```

The proposed bulk tool replaces central-loop expansion.

### New capability: comparison

Question:

```text
Compare Rob Cross and Gerwyn Price over their last 20 matches.
```

Path:

```text
getPlayersMatchAverages -> comparePlayers -> final
```

### New capability: form trend

Question:

```text
Is Jack Drayton improving over his last 15 matches?
```

Path:

```text
getPlayerFormTrend({ player: "Jack Drayton", limit: 15, window: 5 }) -> final
```

The trend tool—not Gemma—should fit or compare the windows.

### New capability: head-to-head

Question:

```text
What happened in the last five meetings between Rob Cross and Gerwyn Price?
```

Path:

```text
getHeadToHead({ playerA: "Rob Cross", playerB: "Gerwyn Price", limit: 5 }) -> final
```

### Unsupported capability

Question:

```text
What odds should I bet on tonight?
```

Expected behavior:

```text
I do not have a validated odds or betting-recommendation tool, so I cannot provide that result.
```

The model must not improvise a betting answer from unrelated match averages.

## 13. How to add a new tool safely

For each new capability:

1. Write the user questions it should answer.
2. Identify a permitted, reliable source.
3. Document the source contract and limitations.
4. Define strict Zod input and output schemas.
5. Implement the source client with timeout, retries, rate limiting, and cache rules.
6. Implement deterministic parsing/calculation.
7. Register a small, clear tool definition.
8. Return structured provenance and partial errors.
9. Add unit fixtures for parser and calculation edge cases.
10. Add tool-dispatch tests for malformed arguments and source failures.
11. Add agent tests proving that Gemma selects the tool and does not invent unsupported fields.
12. Run a live test against the source and compare the result with the website.

A source scraper should never be generated dynamically by Gemma. Gemma chooses a registered tool; reviewed code owns the HTTP and parsing behavior.

## 14. Chatbot security and reliability

### Network policy

- Keep an allowlist of source hostnames.
- Do not let a model supply arbitrary URLs to `fetch`.
- Reject non-HTTPS remote URLs except explicitly configured localhost services.
- Do not bypass anti-bot controls or authenticated/private endpoints.

### Input policy

- Validate every API request.
- Limit user-message length.
- Limit session-history length.
- Treat model tool arguments as untrusted input.
- Reject unknown tools and extra properties.

### Runtime policy

- Keep an overall deadline.
- Keep per-source and per-Ollama timeouts.
- Limit model iterations and tool calls.
- Use concurrency limits per remote host.
- Propagate cancellation to Ollama and tools.
- Apply rate limiting to the chatbot endpoint.

### Output policy

- Escape or sanitize rendered Markdown/HTML.
- Never print secrets or complete HTTP headers.
- Log tool metadata, not hidden reasoning.
- Keep unavailable values as `null` or explicit errors, never zero.
- Include actual sample sizes and retrieval timestamps.

## 15. Testing and evaluation plan

### Unit tests

Cover:

- explicit and relative dates;
- player normalization;
- ambiguous names;
- parser schema changes;
- empty or partial match data;
- duplicate fixtures and matches;
- numeric calculations;
- malformed model actions;
- unknown tools;
- timeouts and maximum-loop protection;
- cache hit/miss behavior;
- provenance validation.

### Agent behavior tests

Use a scripted fake model to verify:

- correct tool order;
- parallel calls only after dependencies are known;
- no invented players after discovery;
- no numeric answer before statistics tools run;
- clarification for missing required input;
- honest inability for unsupported questions;
- partial failures remain visible;
- final answers match evidence.

### Golden question set

Maintain English and Hungarian examples:

- last 5/10/20 matches;
- today/tomorrow/Monday;
- one player and multiple players;
- MODUS discovery;
- ambiguous names;
- no fixture date;
- source unavailable;
- DartsOrakel unavailable;
- comparison and trend questions;
- follow-up pronouns with session state;
- unsupported questions.

Record expected tool traces as well as answer requirements. Do not compare exact prose when several correct phrasings are possible.

### Live smoke tests

A scheduled or manually run smoke test should:

1. fetch today's official MODUS data;
2. compare discovered names with the visible official page;
3. resolve one known player;
4. retrieve recent matches;
5. calculate one mean;
6. run one Gemma question end to end;
7. alert on schema or source changes without silently updating fixtures.

## 16. Performance plan

- Reuse one `DartsOrakelClient`, `OllamaClient`, and cache per server process.
- Add a bulk player-statistics tool to reduce model turns and prompt size.
- Keep compact tool results for tasks that only need aggregates.
- Return full match rows only when the user asks for them.
- Cache player identity longer than match data.
- Cache fixture pages by date/year with a freshness policy appropriate to future versus completed events.
- Deduplicate in-flight requests for the same player/date.
- Consider Ollama `keep_alive` so the model remains loaded between chat requests.
- Stream only the final answer; tool actions should stay server-side.

## 17. Troubleshooting

### Ollama connection refused

Check:

```bash
ollama list
curl http://127.0.0.1:11434/api/tags
```

Start Ollama, then retry.

### Model not found

```bash
ollama pull gemma4:12b
```

Or pass an installed model with `--model`.

### Model reports that tools are unsupported

`gemma4:12b` supports native tools. If an explicitly selected older model rejects tools, `OllamaClient` detects the HTTP 400 response and switches to the structured JSON-action protocol. Run with `--debug` and verify that subsequent actions are valid.

### Gemma invents a player or statistic

Do not relax validation. Check:

1. Was the relevant tool result returned?
2. Did the tool include provenance and actual sample size?
3. Is the result compact enough for the model?
4. Does an evidence validator cover this result type?
5. Should a bulk tool replace several model-managed calls?
6. Would a larger Gemma model improve composition?

The safe response is a deterministic formatter or an explicit inability message.

### A scraper misses data

Test the deterministic CLI/tool without Gemma. Inspect the live source and response schema. Update source code and fixtures only after verifying the public contract. The LLM is not part of scraper correctness.

### Follow-ups are forgotten after a restart

Browser backend history is intentionally in memory and is cleared when `npm run chat` restarts. The visible transcript remains in that browser, but start a new conversation after a server restart so visible and backend state agree. Add SQLite only if durable local history is required.

## 18. Recommended implementation roadmap

### Phase 1: chatbot backend — implemented

Deliver:

- validated `/api/chat` endpoint;
- one shared agent instance;
- request cancellation;
- local concurrency backpressure;
- plain-text-safe response rendering;
- Ollama/model health endpoint and actionable errors.

Acceptance criteria:

- the existing one-shot questions work through HTTP;
- invalid input returns HTTP 400;
- timeouts return an actionable error;
- Ollama is never exposed directly to the browser.

### Phase 2: session memory — implemented for local use

Deliver:

- session store;
- recent-turn history;
- clear-session operation;
- context-size limits.

Acceptance criteria:

- “Show Rob Cross's last ten matches” followed by “What is his average?” resolves “his” to Rob Cross;
- a new session does not inherit previous entities;
- expired sessions are removed.

### Phase 3: generic tool registry

Deliver:

- registered tool abstraction;
- standard result/provenance envelope;
- generic dispatcher;
- `clarify` and `cannot_answer` actions;
- per-tool policies.

Acceptance criteria:

- adding a tool does not require editing a central `switch`;
- unknown tools are rejected;
- all input/output is schema validated.

### Phase 4: broader darts research

Deliver first:

1. `getPlayersMatchAverages`;
2. `getHeadToHead`;
3. `getPlayerFormTrend`;
4. `getTournamentFixtures`;
5. `getTournamentResults`;
6. `getRankings` if a reliable source is available.

Acceptance criteria:

- Gemma can compose two or more tools for comparison questions;
- arithmetic and filtering remain deterministic;
- every result includes provenance;
- partial player failures do not fail the whole answer.

### Phase 5: generic evidence validation

Deliver:

- task/evidence requirements;
- reusable answer validators;
- deterministic renderers for lists, comparisons, trends, and head-to-head results;
- answer-repair prompts based only on validated evidence.

Acceptance criteria:

- injected or hallucinated names and numbers are rejected;
- unavailable values remain unavailable;
- all golden questions pass answer and tool-trace checks.

### Phase 6: production operations

Deliver:

- structured metrics;
- health endpoint for Ollama and data sources;
- cache observability;
- source-change alerts;
- scheduled smoke tests;
- deployment documentation and backups for persistent sessions.

## 19. Final design rule

To make Gemma genuinely useful, do not hardcode complete answers and do not give the model unrestricted network access.

Instead:

- give Gemma a growing set of small, well-described capabilities;
- let it choose and combine those capabilities;
- keep source access and calculations deterministic;
- retain conversational state explicitly;
- validate every factual answer against collected evidence;
- admit when no installed capability can answer a question.

That design lets the chatbot answer new combinations of darts questions without turning Gemma into either a decorative formatter or an unreliable web scraper.

## 20. Official Ollama references

- Chat API: https://docs.ollama.com/api/chat
- Tool calling and agent loops: https://docs.ollama.com/capabilities/tool-calling
- Structured outputs and JSON schemas: https://docs.ollama.com/capabilities/structured-outputs
- Gemma 4 model and requirements: https://ollama.com/library/gemma4

The implementation intentionally uses the local Ollama API rather than Ollama Cloud because the application depends on local models, local source policies, and structured tool orchestration.
