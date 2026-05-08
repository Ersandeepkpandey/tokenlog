# AI Token Tracker

Real-time token usage and cost tracking for Claude, GPT, and all major AI models — directly in VS Code.

## Features

- **Live session bar** — see input, output, cache tokens and estimated cost update as you work
- **Daily cost chart** — 30-day bar chart of your spending
- **Sessions view** — full history of every Claude Code session with per-session cost breakdown
- **Model breakdown** — see which models cost the most and compare alternatives
- **Projects view** — cost attribution per project
- **Model comparison** — instantly see what your current session would have cost on a different model
- **CSV export** — download your full usage history locally
- **No sign-in required** — reads directly from `~/.claude/` logs, fully local

## Supported Models

| Model | Input | Output |
|-------|-------|--------|
| Claude Opus 4 | $15/M | $75/M |
| Claude Sonnet 4 | $3/M | $15/M |
| Claude Haiku 3.5 | $0.80/M | $4/M |
| GPT-4o | $2.50/M | $10/M |
| GPT-4o mini | $0.15/M | $0.60/M |

## Usage

1. Install the extension
2. Open the Command Palette (`Ctrl+Shift+P`) → **AI Token Tracker: Show Dashboard**
3. Or click the status bar item at the bottom right

The extension auto-detects Claude Code logs from `~/.claude/projects/`. No configuration needed.

## Commands

| Command | Description |
|---------|-------------|
| `AI Token Tracker: Show Dashboard` | Open the full dashboard |
| `AI Token Tracker: Set Model` | Change default model for cost calculation |
| `AI Token Tracker: Export Data (CSV)` | Save usage history to a CSV file |
| `AI Token Tracker: Reset Current Session` | Clear the active session counter |

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `aiTokenTracker.model` | `claude-sonnet-4` | Default model for cost calculation |
| `aiTokenTracker.claudeLogPath` | _(auto)_ | Custom path to Claude logs |
| `aiTokenTracker.showStatusBar` | `true` | Show/hide status bar item |
