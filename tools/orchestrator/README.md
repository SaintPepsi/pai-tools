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
pait orchestrate --no-verify        # Skip verification requirement
pait orchestrate --parallel 3       # Run up to 3 issues concurrently
pait orchestrate --file PLAN.md     # Read tasks from markdown checklist
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
  "allowedTools": "Bash(bun:*) Bash(git:*) Edit Write Read Glob Grep",
  "allowedAuthors": ["SanCoca", "trusted-collaborator"]
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
| `verify` | `[]` (prompts on first run) |
| `e2e` | not set (E2E step skipped) |
| `allowedAuthors` | authenticated `gh` user only |

## Verification

Verification steps are **required** by default. If no `verify` commands are configured in `.pait/orchestrator.json`, the orchestrator will interactively prompt you to provide them on first run. The commands you enter are saved to `.pait/orchestrator.json` so future runs don't re-prompt.

Use `--no-verify` to bypass this requirement entirely (not recommended for production use).

## Security

The orchestrator only processes issues authored by the authenticated `gh` user. This prevents prompt injection attacks where a malicious actor creates a GitHub issue on a public repo with crafted instructions that would be fed to the implementation agent.

To allow issues from additional trusted collaborators, add `allowedAuthors` to your config:

```json
{
  "allowedAuthors": ["your-username", "trusted-collaborator"]
}
```

When `allowedAuthors` is not set, the orchestrator resolves the current user via `gh api user` and only fetches their issues.

## State

Orchestrator state is stored at `.pait/state/orchestrator.json`. Add `.pait/state/` to your project's `.pait/.gitignore`.

On first run, if a legacy `scripts/.orchestrator-state.json` exists, it is auto-migrated to the new location.
