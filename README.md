# DartsOrakel scraper and local Gemma 4 chatbot

Production-oriented TypeScript tooling for DartsOrakel player matches plus a browser chatbot powered locally by Ollama and `gemma4:12b`. Gemma plans tool use and explains results; fixture discovery, player resolution, match scraping, and averages stay deterministic and validated.

## Start the chatbot

Requirements: Node.js 18+, npm, a current Ollama installation, and enough memory to run the 7.6 GB Gemma 4 model.

```powershell
npm install
ollama pull gemma4:12b
npm run chat
```

Or simply double-click `start-chatbot.cmd`; it starts Ollama/model setup, launches the chatbot, and opens the browser automatically.

Open [http://127.0.0.1:3210](http://127.0.0.1:3210). The header must show **Ollama ready** before a question can be sent.

The web app provides:

- natural-language English and Hungarian darts research;
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

- `.cache/dartsorakel`: long-lived player directory and five-minute match responses
- `.cache/modus-results`: official MODUS results cached for 15 seconds
- `.cache/modus`: fixture discovery cached for 30 seconds for today and six hours for other dates

Cache failures are non-fatal. Delete `.cache` manually only when intentionally forcing a complete live refresh.

## Documentation

- [Full local user manual](./manual.md)
- [Original chatbot extension guide](./docs/CHATBOT_MANUAL.md)
- [Agent architecture](./docs/AGENT_ARCHITECTURE.md)
- [Official MODUS optimization plan](./docs/MODUS_OPTIMIZATION_PLAN.md)
- [MODUS source investigation](./docs/MODUS_SOURCE_INVESTIGATION.md)
- [Tool contracts](./docs/TOOL_CONTRACTS.md)
- [DartsOrakel investigation](./INVESTIGATION.md)

Current MODUS results come from the official daily JSON and exact official weekly-average page. Participant-only discovery can fall back to the allowed public Darts Nerd season page. PDC and explicit last-N history remain on DartsOrakel. The app does not bypass anti-bot controls or use private APIs.
