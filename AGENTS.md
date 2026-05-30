# pilingual

Pi extension that intercepts assistant responses, translates them via an
OpenAI-compatible chat completion API, and renders the original and translation
side-by-side in the TUI.

- Target language is configurable (defaults to Spanish).
- Supports any pi-registered `openai-completions` model, or a manual fallback
  endpoint via `PILINGUAL_*` environment variables.

## Stack

- TypeScript pi extension.
- Runtime imports from `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`.

## Structure

```
extensions/
  pilingual.ts   — Extension entry point
```

## Conventions

- Keep `AGENTS.md` updated as structure emerges.
- Prefer flat directory structure until >8 files in one dir.
- Don't commit `.pi/` to version control.

## Commands

- Install dependencies: `npm install`
- Type-check extension: `npm run typecheck`

## Configuration

Runtime env vars (optional):

| Variable | Purpose |
|----------|---------|
| `PILINGUAL_PROVIDER` | Initial pi provider ID |
| `PILINGUAL_MODEL` | Initial model ID |
| `PILINGUAL_TARGET_LANGUAGE` | Target language (default: Spanish) |
| `PILINGUAL_MAX_CHARS` | Skip translation above this length; 0 disables (default: 8000) |

Manual fallback (optional):

| Variable | Purpose |
|----------|---------|
| `PILINGUAL_ADAPTER` | `openai-compatible` |
| `PILINGUAL_API_KEY` | API key for fallback endpoint |
| `PILINGUAL_BASE_URL` | Base URL for fallback endpoint |
| `PILINGUAL_MODEL` | Model ID for fallback endpoint |

State is persisted to `<agent-dir>/pilingual.json`.

## Notes

- Project path: `/Users/jesus/Documents/dev/pi-say`
- Created: 2026-05-30
- Suggested installed path: `~/.pi/agent/extensions/pilingual.ts`
