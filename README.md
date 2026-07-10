# Wegate

Personal WeChat message gateway via official iLink API.

Wegate lets you **send and receive WeChat messages** programmatically through Tencent's official iLink Bot protocol — no unofficial hacks, no risk of account suspension.

## Features

- **QR code login** — scan once, session persists across restarts
- **Receive messages** — long-polling with automatic `context_token` capture
- **Send messages** — proactive push to any contact who messaged you first
- **Docker ready** — one command to deploy, volume-mounted session persistence

## Quick Start

```bash
# Clone and install
git clone https://github.com/XiaoYingGee/wegate.git
cd wegate && npm install

# Run (displays QR code in terminal, scan with WeChat)
npm run dev
```

### Docker

```bash
docker compose up -d
docker attach wegate  # scan QR code, then detach with Ctrl+P Ctrl+Q
```

Session data is persisted in `./data/` (gitignored).

## How It Works

```
WeChat User ←→ iLink API ←→ Wegate (long-poll loop) ←→ Your Services
```

1. **Login**: Wegate fetches a QR code from iLink API, you scan it with WeChat
2. **Receive**: Long-polling `getUpdates` captures incoming messages and their `context_token`
3. **Send**: Using the captured `context_token`, Wegate can send messages back via `sendMessage`

> **Important**: You must receive at least one message from a contact before you can send to them — this is an iLink API constraint, not a Wegate limitation.

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `WEGATE_DATA_DIR` | `./data` | Directory for session persistence |

## Project Structure

```
src/
├── client/ilink.ts   # iLink HTTP API client (login, getUpdates, sendMessage)
├── store/session.ts   # JSON file persistence (tokens, peers, cursor)
└── index.ts           # CLI entry point (QR login → message loop → interactive chat)
```

## Roadmap

- [ ] HTTP API (`/api/send`, `/api/webhook`, `/api/status`) for external service integration
- [ ] Message router with prefix-based routing to multiple backends
- [ ] Media message support (images, files, voice)
- [ ] WebUI management console

## License

MIT
