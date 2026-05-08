# Contributing to TokenLog

Thank you for your interest in contributing to TokenLog! 🎉

## Getting Started

### Prerequisites
- Node.js 18+
- pnpm (`npm install -g pnpm`)
- VS Code

### Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/tokenlog.git
   cd tokenlog
   ```
3. Install dependencies:
   ```bash
   pnpm install
   ```
4. Set up the extension:
   ```bash
   cd apps/extension
   npm install
   node esbuild.js
   ```
5. Press **F5** in VS Code to launch the Extension Development Host

### Project Structure

```
tokenlog/
├── apps/
│   ├── extension/     # VS Code extension (TypeScript)
│   │   ├── src/
│   │   │   ├── extension.ts      # Main entry point, dashboard UI
│   │   │   ├── tokenTracker.ts   # Reads ~/.claude/ logs
│   │   │   ├── authManager.ts    # Authentication
│   │   │   ├── usageSync.ts      # Syncs data to API
│   │   │   └── pricing.ts        # Model pricing table
│   ├── api/           # Fastify API server
│   └── web/           # Next.js web dashboard
```

## How to Contribute

### Reporting Bugs
- Use the [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md) template
- Include your OS, VS Code version, and extension version

### Suggesting Features
- Use the [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md) template
- Explain the use case clearly

### Submitting a Pull Request

1. Create a new branch from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. Make your changes
3. Test the extension by pressing F5
4. Commit with a clear message:
   ```bash
   git commit -m "feat: add support for XYZ model"
   ```
5. Push and open a PR against `main`
6. Fill out the PR template

### Commit Message Format
```
feat: add new feature
fix: fix a bug
docs: update documentation
refactor: code refactor
chore: maintenance tasks
```

## Adding a New AI Model

Edit `apps/extension/src/pricing.ts` and add the model with its pricing:

```typescript
'your-model-name': { input: 0.00, output: 0.00, cacheRead: 0.00, cacheWrite: 0.00 },
```

Prices are in USD per 1 million tokens.

## Code Style
- TypeScript for all extension code
- Keep functions small and focused
- No unnecessary dependencies

## Questions?
Open a [GitHub Discussion](https://github.com/Ersandeepkpandey/tokenlog/discussions) or file an issue.
