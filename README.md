# Magpi

Open-source Discord bot extension for the [Pi coding agent](https://github.com/badlogic/pi-mono).

Bridges Pi to a Discord channel with persistent sessions, @mentions, DMs, file uploads, and emoji reaction context — **running as a detached daemon that survives Pi restarts**.

## Architecture

```
 ┌──────────┐     /magpi commands      ┌─────────────────┐
 │  Pi TUI  │ ◄──────────────────────────► │  Extension      │
 └──────────┘    start/stop/status/reset    │  (extension.ts) │
                                            └────────┬────────┘
                                                     │ spawn, SIGTERM, SIGUSR1
                                                     ▼
                                            ┌─────────────────┐
                                            │  Daemon          │
                                            │  (daemon.ts)     │
                                            └────────┬────────┘
                                                     │ Pi SDK
                                                     ▼
                                            ┌─────────────────┐
                                            │  Pi AgentSession │◄──── Discord ◄──── Users
                                            └─────────────────┘
```

The daemon is a **detached background process** — it survives Pi exits and restarts. The Pi extension only manages it (start, stop, check status, reset session).

## Features

- **Detached daemon** — bot stays online even when Pi exits; survives Pi restarts
- **Persistent Pi session** — remembers conversation context across messages
- **@mention trigger** — only responds when mentioned in the channel (no spam)
- **DM support** — talk to Pi privately, with optional user allowlisting
- **File uploads** — send images to Pi for analysis
- **👀 Reaction** — bot reacts with eyes when processing, ✅ when done, ❌ on error (no message editing during generation)
- **Reaction context** — emoji reactions on bot messages become passive context for Pi
- **Clean response delivery** — sends the full response only after Pi finishes generating (no mid-generation message edits)
- **Long responses** — automatically splits into multiple messages for >2000 char output
- **Output sanitization** — API keys, tokens, and server paths are auto-redacted
- **Rate limiting** — 5 messages per 30 seconds per user prevents flooding
- **Unix signal control** — SIGTERM to stop, SIGUSR1 to reset session

## Security

This extension was built from scratch with security as a first-class concern, specifically because the alternative ([`pi-discord`](https://npm.im/pi-discord)) is closed-source and unauditable.

**Built-in protections:**

| Threat | Mitigation |
|--------|------------|
| API key/token leaks | Output sanitization redacts `sk-*`, tokens, and sensitive env vars |
| Server path disclosure | Absolute paths truncated to last component |
| Message flooding | Per-user rate limiting (5 messages/30s) |
| Unauthorized DM access | Configurable DM user allowlist |
| Malicious file uploads | Size limit (10MB default) + MIME type allowlist |
| Bot token exposure | Token never logged, never in output, validated at load |
| Channel leakage | Only responds in the explicitly configured channel |
| Daemon process security | Runs as the same user as Pi; PID file in `~/.magpi/`; no elevated privileges |

**To audit this extension yourself:**
```bash
# Every source file is readable TypeScript
cat ~/magpi/src/{extension,daemon,bot,session,config}.ts
# Key change: bot.ts no longer streams edits — it waits for the full response
```

## Setup

### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" → give it a name
3. Go to **Bot** → click "Reset Token" → copy the token
4. Enable **Message Content Intent** and **Server Members Intent**
5. Go to **OAuth2** → **URL Generator**
6. Scopes: `bot`
7. Bot Permissions: `Send Messages`, `Read Message History`, `Add Reactions`, `Attach Files`
8. Copy the URL and invite the bot to your server
9. Note your **Application ID** (from the General Information page)

### 2. Configure magpi

```bash
cd ~/magpi
cp .env.example .env
```

Edit `.env`:
```env
DISCORD_BOT_TOKEN=your-bot-token-here
DISCORD_APPLICATION_ID=your-application-id-here
DISCORD_CHANNEL_ID=your-channel-id-here
```

To find a channel ID: enable Developer Mode in Discord settings, then right-click a channel → Copy Channel ID.

### 3. Install dependencies

```bash
cd ~/magpi
npm install
```

### 4. Run with Pi

```bash
# Load the extension in Pi
pi -e ~/magpi/src/extension.ts
```

Then in Pi:
```
/magpi start    # Spawn the detached daemon
/magpi status   # Check if it's running
/magpi logs     # View recent daemon output
```

**The daemon stays running even after you close Pi.** To stop it explicitly:
```
/magpi stop     # Graceful shutdown (SIGTERM)
```

### 5. Use in Discord

In the configured channel, @mention the bot:
```
@your-bot check the repo status and summarize
@your-bot what files are in the current directory?
```

Or send a DM directly to the bot.

## Commands (inside Pi)

| Command | Description |
|---------|-------------|
| `/magpi start` | Spawn the detached daemon process |
| `/magpi stop` | Stop the daemon (sends SIGTERM) |
| `/magpi status` | Check if the daemon is running |
| `/magpi reset` | Reset the Pi session (sends SIGUSR1) |
| `/magpi logs [N]` | Show last N lines of daemon log (default: 30) |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | ✅ | — | Discord bot token |
| `DISCORD_APPLICATION_ID` | ✅ | — | Discord application ID |
| `DISCORD_CHANNEL_ID` | ✅ | — | Channel to listen in |
| `DISCORD_DM_ALLOWLIST` | ❌ | all | Comma-separated user IDs allowed to DM |
| `DISCORD_ADMIN_IDS` | ❌ | none | Comma-separated user IDs with admin rights |
| `DISCORD_MODEL` | ❌ | first available | Pi model (e.g., `anthropic/claude-sonnet-4-20250514`) |
| `DISCORD_THINKING_LEVEL` | ❌ | model default | off, minimal, low, medium, high, xhigh |
| `DISCORD_MAX_UPLOAD_SIZE` | ❌ | 10MB | Max file upload size in bytes |
| `DISCORD_ALLOWED_MIME_TYPES` | ❌ | image/*, text/plain | Comma-separated MIME types |

## Direct Daemon Control

You can also manage the daemon directly without Pi:

```bash
# Start the daemon directly
npx tsx ~/magpi/src/daemon.ts

# Send signals
kill -SIGTERM $(cat ~/.magpi/daemon.pid)   # Stop
kill -SIGUSR1 $(cat ~/.magpi/daemon.pid)    # Reset session

# View logs
tail -f ~/.magpi/daemon.log
```

## Project Structure

```
magpi/
├── package.json          # Dependencies, pi manifest, daemon bin
├── tsconfig.json         # TypeScript configuration
├── .env.example          # Environment variable template
├── .gitignore
├── README.md             # This file
└── src/
    ├── extension.ts      # Pi extension — manages daemon via /magpi commands
    ├── daemon.ts         # Detached background process entry point
    ├── bot.ts            # Discord client, event routing, throttling, sanitization
    ├── session.ts        # Pi session lifecycle (create, resume, reset, persist)
    └── config.ts         # Configuration loader and validator
```

## Signal Reference

| Signal | Effect |
|--------|--------|
| `SIGTERM` | Graceful shutdown — stops bot, cleans up PID file |
| `SIGUSR1` | Reset Pi session — starts a fresh conversation |
| `SIGINT` | Ignored — the daemon is detached from the terminal |

## Daemon Data

All daemon state lives in `~/.magpi/`:

```
~/.magpi/
├── daemon.pid        # PID of the running daemon
├── daemon.log        # Daemon stdout/stderr output
└── sessions/         # Per-thread session directories (JSONL files + agent workspace)
    └── <threadId>/ # One directory per Discord thread
        └── *.jsonl # Pi SDK session data (conversation history, tool calls)
```

Sessions survive daemon restarts and crashes — the bot resumes the most recent conversation for each thread automatically. To start fresh, use `/magpi reset` (or send `SIGUSR1`).

## License

MIT
