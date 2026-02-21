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

Automated GitHub issue implementation orchestrator. Reads open issues, topologically sorts by dependencies, optionally splits large issues into sub-issues, then implements each via Claude agents with full verification.

```bash
pait orchestrate                    # Run from first unfinished issue
pait orchestrate --dry-run          # Show execution plan without acting
pait orchestrate --status           # Show current progress
pait orchestrate --single           # Run only the next issue, then stop
pait orchestrate --single 115       # Run only issue #115
pait orchestrate --from 109         # Start from issue #109
pait orchestrate --reset            # Clear state and start fresh
pait orchestrate --skip-e2e         # Skip E2E verification step
pait orchestrate --skip-split       # Skip issue splitting assessment
```

## Project Config

Each target project stores its config in a `.pait/` directory at the repo root.

### `.pait/orchestrator.json`

```json
{
  "verify": [
    { "name": "check", "cmd": "bun run check" },
    { "name": "test", "cmd": "bun run test" }
  ],
  "e2e": {
    "run": "bun run test:e2e",
    "update": "bun run test:e2e:update",
    "snapshotGlob": "*.png"
  },
  "allowedTools": "Bash(bun:*) Bash(git:*) Edit Write Read Glob Grep"
}
```

All fields are optional. Defaults:

| Field | Default |
|-------|---------|
| `branchPrefix` | `feat/` |
| `baseBranch` | `master` |
| `models.implement` | `sonnet` |
| `models.assess` | `haiku` |
| `retries.implement` | `1` |
| `retries.verify` | `1` |
| `allowedTools` | `Bash Edit Write Read Glob Grep` |
| `verify` | `[]` (no verification commands) |
| `e2e` | not set (E2E step skipped) |

### State

Orchestrator state is stored at `.pait/state/orchestrator.json`. Add `.pait/state/` to your project's `.pait/.gitignore`.

On first run, if a legacy `scripts/.orchestrator-state.json` exists, it is auto-migrated to the new location.

## Architecture

```
pai-tools/
├── cli.ts                          # Entry point, subcommand routing
├── shared/
│   ├── log.ts                      # Colored terminal logging
│   ├── claude.ts                   # Claude CLI helper (stdin piping)
│   └── config.ts                   # .pai/ discovery, config loading, state paths
└── tools/
    └── orchestrator/
        ├── index.ts                # Main orchestration logic
        ├── types.ts                # TypeScript interfaces
        └── defaults.ts             # Default config values
```

## Requirements

- [Bun](https://bun.sh)
- [GitHub CLI](https://cli.github.com) (`gh`)
- [Claude Code](https://claude.ai/code) (`claude`)
