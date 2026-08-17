# DartsOrakel scraper and local Gemma 4 chatbot

Production-oriented TypeScript tooling for DartsOrakel player matches plus a browser chatbot powered locally by Ollama and `gemma4:12b`. Supported live-stat questions use a near-instant deterministic path with no model call; Gemma plans tools and explains open-ended questions.

## Private Telegram bot

The bot is an owner-only, free-tier webhook around deterministic official MODUS history and DartsOrakel readers. It needs no database, paid API, queue, Redis, or language model.

Vercel datacenter addresses receive a Cloudflare managed challenge from DartsOrakel. The bot therefore retrieves only the public DartsOrakel JSON through Jina Reader's free public-URL service; no Telegram identity, token, or message metadata is sent to Jina.

1. Use Node.js 24 and run `npm install`.
2. Copy the three Telegram settings from [`.env.example`](./.env.example) to `.env.local`. Generate `WEBHOOK_SECRET` yourself; it is not supplied by Telegram.
3. Run `npm run build`, `npm test`, and `npm run audit:prod`.
4. Create a Vercel Hobby project from this directory and add `BOT_TOKEN`, `ALLOWED_USER_ID`, and `WEBHOOK_SECRET` as encrypted project environment variables.
5. Deploy, then register `https://<deployment-domain>/api/telegram-webhook` with Telegram's `setWebhook`, passing the same value as `secret_token`.

Send the bot a private message such as `Dylan Slevin last 10 match`, `Jack Drayton last 10 matches from MODUS`, or `Rob Cross last 10 matches from DartsOrakel`. “Average,” “stats,” and plural “matches” are optional; each response includes the match averages and their mean. Without `from ...`, source selection is automatic: players in the bundled current MODUS series use official MODUS match details, while every other player goes immediately to DartsOrakel without a MODUS network request. An explicit `from MODUS` request checks the live official catalogue even when the bundled index has not yet seen today's player. MODUS rows include their official proof URL. `/start` and `/help` show examples; `/health` verifies Telegram delivery without calling a statistics source. Updates from every other user, group, or channel are silently ignored.

`npm run telegram:smoke` performs a real end-to-end check using `.env.local`; it sends and edits one Rob Cross result in the owner's Telegram chat.

`npm run modus:players:smoke` discovers every player in the current official MODUS series/week and validates each player sequentially through the forced official-history route. It fails if any player cannot return official match rows with aligned MODUS proof URLs.

`npm run modus:smoke -- "Jack Drayton" 10` performs a read-only live contract test against the official MODUS results and match-detail pages without sending a Telegram message. `npm run modus:index` rebuilds the bundled official historical catalogue; run it before a production deployment. The runtime still refreshes the current official week, so newly completed matches do not require a redeploy.

## Start the chatbot

Requirements: Node.js 18+, npm, a current Ollama installation, and enough memory to run the 7.6 GB Gemma 4 model.

```powershell
npm install
ollama pull gemma4:12b
npm run chat
```

Or simply double-click `start-chatbot.cmd`; it starts Ollama, preloads Gemma for 30 minutes, preloads live MODUS/player data, launches the chatbot, and opens the browser automatically.

Open [http://127.0.0.1:3210](http://127.0.0.1:3210). **Stats ready** can answer supported factual lookups without Ollama; **Ollama ready** also supports explanations and open-ended research.

The web app provides:

- natural-language English and Hungarian darts research;
- deterministic fast-path answers for latest MODUS and named-player last-N facts;
- deterministic DartsOrakel and MODUS tools selected by Gemma;
- multi-turn follow-up context per browser session;
- local health/model checks and actionable setup errors;
- cancellation, bounded request concurrency, conversation limits, and safe table/text rendering;
- a same-origin local API with restrictive browser security headers.

Prompts, chat history, and inference remain on this machine. Current darts data still comes from the configured public sources.

## Configuration

Defaults are listed in [`.env.example`](./.env.example). The app reads shell environment variables; it does not load `.env` automatically.

```powershell
$env:OLLAMA_MODEL = "gemma4:12b"
$env:OLLAMA_BASE_URL = "http://127.0.0.1:11434"
$env:OLLAMA_KEEP_ALIVE = "30m"
$env:CHAT_HOST = "127.0.0.1"
$env:CHAT_PORT = "3210"
npm run chat
```

Keep `CHAT_HOST=127.0.0.1` unless you intentionally add authentication and network controls. Conversation memory is in-process with a six-hour inactivity TTL, so restarting the server clears backend context.

## Terminal agent

One shot:

```powershell
npm run agent -- "Show Rob Cross's last 10 matches and calculate his match average."
npm run agent -- --debug "Who plays MODUS on 2026-08-10? Show each player's last-10 average."
```

Interactive, with follow-up history:

```powershell
npm run agent
```

`--debug` writes structured tool calls, timing, and failure codes to stderr. It never prints hidden model reasoning.

## Direct player CLI

```powershell
npm run player -- "Damon Heta" 10
npm run player -- "Damon Heta" 10 --json
npm run player -- "Robert Thornton" 10
```

## Validation

```powershell
npm run build
npm test
npm run audit:prod
```

## Caching

- memory L1: MODUS refreshes every 10 seconds; player results stay fresh for 15 seconds; identical requests are single-flight
- `.cache/dartsorakel`: 30-day player directory and 10-second bounded-history HTTP responses
- `.cache/modus-results`: validated process-restart fallback, rejected after five minutes
- `.cache/modus`: fixture discovery cached for 30 seconds for today and six hours for other dates

Cache failures are non-fatal. Delete `.cache` manually only when intentionally forcing a complete live refresh.

## Documentation

- [Full local user manual](./MANUAL.md)
- [Original chatbot extension guide](./docs/CHATBOT_MANUAL.md)
- [Agent architecture](./docs/AGENT_ARCHITECTURE.md)
- [Official MODUS optimization plan](./docs/MODUS_OPTIMIZATION_PLAN.md)
- [MODUS source investigation](./docs/MODUS_SOURCE_INVESTIGATION.md)
- [Tool contracts](./docs/TOOL_CONTRACTS.md)
- [DartsOrakel investigation](./INVESTIGATION.md)

Current MODUS results and Telegram MODUS history come from the public official results, match-detail, daily JSON, and weekly-average pages. Participant-only discovery in the local research app can fall back to the allowed public Darts Nerd season page. The Telegram bot never uses that fallback for MODUS statistics: each MODUS match is backed by its official match-detail URL. The app does not bypass anti-bot controls or use private APIs.
