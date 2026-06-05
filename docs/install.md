# Installation

## Requirements

- **Node.js ≥ 18** (LTS 20 or 22 recommended).
- A running [Ollama](https://ollama.com) server with a model pulled — needed for `chat` and `agent` only. `exec`, `audit`, `policy`, and `eval` run without a model.
- Git (for the `git` tool and for cloning the repo).

## Install from source (current method)

```bash
git clone https://github.com/christianafram/openllama.git
cd openllama
npm install
npm run build

# Optional: install globally
npm install -g .

# Or use directly:
node dist/index.js chat "hello"
```

### Environment variables

Copy `.env.example` and adjust:

```bash
cp .env.example .env
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama server base URL |
| `OPENLLAMA_MODEL` | `qwen2.5-coder:7b` | Default model for chat/agent |
| `OPENLLAMA_AUDIT_DB` | `~/.local/share/openllama/audit.db` | Audit ledger path |

Config file (`~/.config/openllama/config.json`) takes the same keys and is read at startup.

## npm registry (planned — v0.8)

```bash
npm install -g opencli   # not yet published
```

The npm package will be published when binary signing infrastructure is in place (EX-2026-002). Until then, install from source.

## Multi-platform notes

### Linux (x86_64, ARM64)

Fully supported. The primary development and CI platform is Ubuntu 22.04+ via GitHub Actions (Node 20).

```bash
# Verify Node version
node --version   # should be ≥ 18

# Ollama
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5-coder:7b

# OpenCLI
git clone https://github.com/christianafram/openllama.git && cd openllama
npm install && npm run build
```

### macOS (Apple Silicon / Intel)

Supported. Ollama has a native macOS app. Node via Homebrew or `nvm`.

```bash
brew install node          # or: nvm install 22
# Install and start Ollama from https://ollama.com
ollama pull qwen2.5-coder:7b

git clone https://github.com/christianafram/openllama.git && cd openllama
npm install && npm run build
```

### Windows

Supported via Node.js on Windows + Ollama for Windows.

1. Install [Node.js 22 LTS](https://nodejs.org).
2. Install [Ollama for Windows](https://ollama.com/download/windows).
3. Open PowerShell or WSL2 and run:

```powershell
ollama pull qwen2.5-coder:7b
git clone https://github.com/christianafram/openllama.git
cd openllama
npm install
npm run build
node dist/index.js chat "hello"
```

WSL2 is the smoother path for development; native Windows works but some shell tool tests may behave differently.

### Bun (experimental)

`better-sqlite3` requires a native Node.js addon; Bun's Node compatibility layer supports it but is less tested. If you use Bun:

```bash
bun install
bun run build   # tsup targets node, output is standard ESM
```

Run with `node dist/index.js` (not `bun run dist/index.js`) until Bun's native addon support stabilises.

## Single-file executable (future — v0.8+)

The plan for frictionless distribution is a single-file executable via Node.js SEA (`node --experimental-sea-config`) or Bun's `bun build --compile`. The integrity-critical sliver (audit chain verification) may be packaged as a standalone binary. This is tracked as a v0.8 item; the goal is `brew install opencli` / `winget install opencli`.

## Verifying the build

```bash
# Verify the build is correct
npm run typecheck   # zero type errors
npm test            # all tests pass
npm run build       # dist/ populated

# Smoke test (no Ollama needed)
node dist/index.js exec read_file --json '{"path":"README.md"}'
node dist/index.js audit verify
```

## Updating

```bash
git pull origin main
npm install          # picks up any new deps
npm run build
```

Review `CHANGELOG.md` for breaking changes before updating in a production workflow.
