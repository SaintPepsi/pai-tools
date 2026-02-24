# pai-tools

Reusable CLI tooling for [PAI](https://github.com/danielmiessler/Personal_AI_Infrastructure)-powered development workflows. Run across any project — per-project config lives in `.pait/`.

## Install

```bash
bun install
bun link
```

This makes the `pait` command available globally.

## Usage

```bash
pait <command> [flags]
```

### `pait orchestrate`

Automated GitHub issue implementation orchestrator. See [tools/orchestrator/README.md](tools/orchestrator/README.md) for usage, config, and options.

### `pait analyze`

AI-powered file structure analyzer. Two-tier approach: fast heuristics flag candidates, then Claude Sonnet detects SRP/DIP violations and suggests concrete file splits. Supports 10 languages, GitHub issue creation, and JSON output for CI.

```bash
pait analyze ./src                    # Full analysis
pait analyze ./src --tier1-only       # Heuristics only (free)
pait analyze ./src --issues --dry-run # Preview GitHub issues
```

See [tools/analyze/README.md](tools/analyze/README.md) for full docs, flags, and config.

### `pait verify`

Standalone verification runner. Reads verify commands from `.pait/orchestrator.json` and runs them. Supports step filtering, E2E skip, and JSON output.

```bash
pait verify                      # Run all verification steps
pait verify --name test          # Run only the "test" step
pait verify --skip-e2e --json    # Skip E2E, output JSON
```

See [tools/verify/README.md](tools/verify/README.md) for full docs and programmatic API.

### `pait finalize`

Interactive PR merge tool. Discovers completed orchestrated PRs, handles conflicts with user input + Claude resolution, and re-verifies after each merge.

```bash
pait finalize --dry-run          # Preview merge plan
pait finalize --single           # Merge one PR at a time
pait finalize --strategy merge   # Use merge commits instead of squash
```

See [tools/finalize/README.md](tools/finalize/README.md) for full docs and conflict resolution UX.

### `pait update`

Pull the latest pai-tools from the remote repository. Since `bun link` symlinks to the repo, this is all you need to stay current.

```bash
pait update
```

## Project Config

Each target project stores its config in a `.pait/` directory at the repo root. See individual tool READMEs for config schema.

## Architecture

```
pai-tools/
├── cli.ts                          # Entry point, subcommand routing
├── CLAUDE.md                       # AI agent instructions for this repo
├── shared/
│   ├── log.ts                      # Colored terminal logging
│   ├── claude.ts                   # Claude CLI helper (stdin piping)
│   ├── config.ts                   # .pait/ discovery, config loading/saving, state paths
│   └── logging.ts                  # Structured JSONL run logging
└── tools/
    ├── orchestrator/
    │   ├── README.md               # Orchestrator docs, config, usage
    │   ├── index.ts                # Main orchestration logic
    │   ├── types.ts                # TypeScript interfaces
    │   └── defaults.ts             # Default config values
    ├── verify/
    │   ├── README.md               # Verify tool docs, flags, API
    │   ├── index.ts                # Standalone verification runner
    │   └── types.ts                # Verify types (VerifyCommand, VerifyResult, etc.)
    ├── finalize/
    │   ├── README.md               # Finalize tool docs, conflict UX
    │   ├── index.ts                # PR merge with conflict resolution
    │   └── types.ts                # Finalize types (FinalizeFlags, MergeOrder, etc.)
    └── analyze/
        ├── README.md               # Analyze tool docs, flags, config
        └── index.ts                # File structure analyzer (heuristics + AI)
```

## Requirements

- [Bun](https://bun.sh)
- [GitHub CLI](https://cli.github.com) (`gh`)
- [Claude Code](https://claude.ai/code) (`claude`)
