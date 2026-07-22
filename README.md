# agent-lens

An open-source, local-first agentic tracing platform: install a plugin in your agent harness (Claude Code first), spin up a local UI, and inspect everything your agent did in a session — tool calls, sub-agents, prompts, inputs/outputs — so you can improve your workflow and guide the agent better.

## Status

Pre-alpha. Product spec and technical planning live in [`internal_docs/agent-lens/`](internal_docs/agent-lens/) — start with [`PROJECT.md`](internal_docs/agent-lens/PROJECT.md).

## Development

Requires Node.js `>=24` (the SQLite layer uses the built-in `node:sqlite`).

```bash
npm install      # installs root + ui deps
npm test         # run the Vitest suite
npm run dev       # boot the Vite UI dev server
npm run typecheck # TypeScript strict check (src + ui)
npm run lint      # ESLint
node ./bin        # print the CLI help
```
