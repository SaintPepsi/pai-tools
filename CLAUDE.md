# pai-tools — Agent Instructions

## Documentation Rules

When adding or modifying a tool:

1. **Tool README** — Every tool in `tools/{name}/` must have a `README.md` covering usage, flags, config, and examples. Update it when the tool's interface changes.
2. **Main README** — Update `README.md` at the repo root when adding a new tool (command listing, architecture tree) or changing the project structure.
3. **CLI help text** — Every tool must handle `--help` and `-h` flags, printing usage info and exiting immediately. Keep help text in sync with the tool README.
4. **HELP constant** — Update the `HELP` string in `cli.ts` when adding new commands or flags.

## Architecture

- `cli.ts` — Entry point. Subcommand routing via a `Map<string, CommandHandler>`.
- `shared/` — Shared utilities. Import from here, don't duplicate.
  - `log.ts` — Colored logging (`log.info`, `log.ok`, `log.warn`, `log.error`, `log.step`) and `Spinner` class.
  - `claude.ts` — `runClaude()` helper. Uses `claude -p` via `Bun.spawn` with stdin piping. Always use this for AI calls.
  - `config.ts` — `findRepoRoot()`, `loadToolConfig()`, `saveToolConfig()`, `getStateFilePath()`. Per-project config lives in `.pait/`.
  - `logging.ts` — `RunLogger` class for structured JSONL run logs. Logs go to `.pait/logs/`.
- `tools/{name}/` — Each tool is a directory with `index.ts` exporting its main function and flag parser.

## Conventions

- TypeScript, Bun runtime, no external runtime dependencies.
- Tools export a main function and a flag parser from `index.ts`.
- Per-project config: `.pait/{toolName}.json`. State: `.pait/state/{toolName}.json`.
- Use `shared/log.ts` for terminal output, not raw `console.log` (except in formatters).
- Use `shared/claude.ts` `runClaude()` for all Claude CLI invocations.
- Colored output via ANSI escape codes, no chalk/picocolors dependency.
- GitHub operations via `gh` CLI, not the REST API directly.

## Security

- **Author filtering:** The orchestrator only processes GitHub issues authored by the authenticated `gh` user (or users listed in `allowedAuthors` config). This prevents prompt injection via malicious public issues. Never bypass this filtering.
- **Verification required:** The orchestrator requires `verify` commands to be configured. If none are set, it prompts the user interactively. Use `--no-verify` to skip (not recommended). Always configure verification for production use.

## Testing

- Run tests: `bun test`
- Run tools directly: `bun run cli.ts <command> [flags]` or via the global alias `pait <command>`.
- **CLI help sync test** (`cli.test.ts`): Asserts every flag in `parseFlags` / `parseAnalyzeFlags` appears in the `HELP` string in `cli.ts`. If you add a flag, update the HELP text or the test will fail.
- Tests are colocated: `tools/{name}/{name}.test.ts` and `shared/{module}.test.ts`.
