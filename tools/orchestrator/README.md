# Orchestrator

Automated GitHub issue implementation orchestrator. Reads open issues, topologically sorts by dependencies, optionally splits large issues into sub-issues, then implements each via Claude agents with full verification.

## Usage

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

## Config

Per-project config lives at `.pait/orchestrator.json` in the target repo.

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

## State

Orchestrator state is stored at `.pait/state/orchestrator.json`. Add `.pait/state/` to your project's `.pait/.gitignore`.

On first run, if a legacy `scripts/.orchestrator-state.json` exists, it is auto-migrated to the new location.
