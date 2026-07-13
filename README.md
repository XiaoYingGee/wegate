# Wegate

Personal WeChat message gateway via official iLink API.

Wegate lets you **send and receive WeChat messages** programmatically through Tencent's official iLink Bot protocol — no unofficial hacks, no risk of account suspension.

## Features

- **QR code login** — scan once, session persists across restarts
- **Receive messages** — long-polling with automatic `context_token` capture
- **Send messages** — proactive push to any contact who messaged you first
- **Sticky routing** — prefix commands (e.g. `#claude`, or any custom prefix you register) switch between processors, plain text follows the last used one
- **Claude Code integration** — default processor spawns Claude Code CLI with session resume
- **HTTP processors** — route messages to any HTTP backend you configure
- **Push API** — `POST /api/send` lets external services push notifications to WeChat
- **systemd ready** — runs as a daemon on your server

## Quick Start

```bash
git clone https://github.com/XiaoYingGee/wegate.git
cd wegate && npm install && npm run build

# First run — displays QR code in terminal, scan with WeChat
npm start
```

## Architecture

```
WeChat ←→ iLink API ←→ Bridge (long-poll) ←→ Router ←→ Processors
                                                │
                                          API Server ←→ External Services
```

### Message Flow

```
Inbound:  WeChat user sends "帮我看看这份文档"
          → Bridge receives via getUpdates
          → Router parses prefix, resolves processor
          → Processor.send(message, chatId)
          → Response sent back via sendMessage

Outbound: External service POSTs to /api/send
          → API Server sends via iLink sendMessage
          → WeChat user receives notification
```

### Sticky Routing

```
#notes 记一下明天开会      →  active = notes, forwards to notes processor
还有别的要加吗            →  still goes to notes (sticky)
#claude                  →  active = claude, resumes previous session
帮我看看这个函数           →  goes to Claude Code
#clear                   →  resets current processor's session
```

## Configuration

All config via environment variables:

| Variable | Default | Description |
|---|---|---|
| `WEGATE_DATA_DIR` | `./data` | Session persistence directory |
| `WEGATE_API_PORT` | `9800` | HTTP API listen port |
| `WEGATE_API_HOST` | `127.0.0.1` | HTTP API listen host |
| `WEGATE_CLAUDE_CMD` | `claude` | Claude Code CLI command |
| `WEGATE_CLAUDE_CWD` | `$HOME` | Working directory for the spawned Claude Code CLI. Claude Code auto-discovers project config (`CLAUDE.md`, `.claude/skills/`) by walking up from its cwd, so pointing this at a project directory loads that project's own skills for messages routed through the `claude` processor |
| `WEGATE_PROCESSORS` | — | Additional processors as a JSON array — the general way to expose any HTTP backend as a `#<name>` command (see below) |
| `WEGATE_ASSET_URL` | — | Convenience shortcut equivalent to registering a `WEGATE_PROCESSORS` entry named `asset` with prefix `#asset` — prefer `WEGATE_PROCESSORS` for anything beyond a single extra backend |
| `WEGATE_API_TOKEN` | — | Optional shared secret; when set, `/api/send` and `/api/status` require a matching `Authorization: Bearer <token>` header |
| `WEGATE_ALLOWED_SENDERS` | — | Optional comma-separated list of WeChat contact IDs allowed to drive processors (e.g. Claude Code). When unset, any contact who messages the bot can drive it |

### Adding Custom Processors

```bash
export WEGATE_PROCESSORS='[{"name":"notes","type":"http","prefix":"#notes","url":"http://localhost:8081/ai/chat"}]'
```

## HTTP API

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/send` | Push a message to WeChat |
| `GET` | `/api/status` | Gateway status |

### Push notification example

```bash
curl -X POST http://127.0.0.1:9800/api/send \
  -H 'Content-Type: application/json' \
  -d '{"text": "Monthly reminder: pay rent"}'
```

If `WEGATE_API_TOKEN` is set, include it as a bearer token:

```bash
curl -X POST http://127.0.0.1:9800/api/send \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $WEGATE_API_TOKEN" \
  -d '{"text": "Monthly reminder: pay rent"}'
```

Without `WEGATE_API_TOKEN`, both endpoints are unauthenticated — fine when bound to `127.0.0.1`, but dangerous if `WEGATE_API_HOST` is exposed beyond localhost.

## Deployment (systemd)

```bash
sudo cp wegate.service /etc/systemd/system/
sudo mkdir -p /opt/wegate
sudo cp -r dist/ package.json node_modules/ /opt/wegate/
# Create /opt/wegate/.env with your config
sudo systemctl enable --now wegate
```

## Project Structure

```
src/
├── client/ilink.ts          # iLink HTTP API client
├── store/session.ts         # JSON file persistence
├── bridge.ts                # QR login + message long-poll loop
├── router.ts                # Sticky prefix-based message router
├── processors/
│   ├── claude.ts            # Claude Code CLI subprocess processor
│   └── http.ts              # Generic HTTP backend processor
├── api.ts                   # HTTP API server (/api/send, /api/status)
├── types.ts                 # Shared interfaces/types
├── config.ts                # Env-var driven config loader
└── index.ts                 # Entry point — assembles all modules
tests/
├── router.test.ts           # Router parsing + sticky routing
├── http-processor.test.ts   # HTTP processor with mocked fetch
├── claude-processor.test.ts # Claude Code CLI subprocess processor
├── config.test.ts           # Config loader
└── session.test.ts          # Session store persistence
```

## Commands (via WeChat)

| Command | Action |
|---|---|
| `#help` | Show available commands |
| `#status` | Current processor and connection status |
| `#claude` | Switch to Claude Code (resumes previous session) |
| `#<processor> <message>` | Forward to a registered processor (e.g. `#asset`, or any custom processor added via `WEGATE_PROCESSORS`) |
| `#clear` | Reset current processor's session |

## Roadmap

- [ ] Media message support (images, files, voice)
- [ ] WebUI management console
- [ ] Python/Go SDK for `/api/send`
- [ ] Message event logging and query API

## License

MIT
