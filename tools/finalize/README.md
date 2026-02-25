# pait finalize

Discover orchestrated PRs and merge them in dependency order.

## Usage

```
pait finalize [flags]
```

## Flags

| Flag | Description |
|------|-------------|
| `--dry-run` | Show merge plan without acting |
| `--single` | Merge only the next PR, then stop |
| `--no-verify` | Skip post-merge verification |
| `--strategy <type>` | Merge strategy: `merge` (default), `squash`, `rebase` |
| `--from <N>` | Start from issue #N |
| `--auto-resolve` | Resolve conflicts via Claude (non-interactive) |
| `--help`, `-h` | Show help message |

## How It Works

1. Reads `.pait/state/orchestrator.json` to find completed issues with open PRs
2. Queries GitHub (`gh pr view`) to confirm PRs are still open
3. Orders PRs by dependency chain (stacked branches) or issue number (independent)
4. For each PR:
   - Rebases onto the target branch (handles stacked PRs after squash merge)
   - Detects and resolves conflicts interactively
   - Merges via `gh pr merge` with the chosen strategy
   - Runs post-merge verification
5. Tracks progress in `.pait/state/finalize.json`

## Conflict Resolution

When a rebase produces conflicts, finalize prompts for each file:

- `ours` — keep the target branch version
- `theirs` — keep the feature branch version
- Any other text — treated as intent, passed to Claude for AI-assisted resolution

### Auto-resolve (`--auto-resolve`)

When `--auto-resolve` is set, conflicts are resolved non-interactively by sending each conflicted file to Claude. Claude merges both sides, preferring the incoming (feature branch) changes when incompatible. This is designed for agent-driven workflows where no human is available to answer prompts.

```bash
pait finalize --auto-resolve
```

## Examples

```bash
# Preview what would be merged
pait finalize --dry-run

# Merge one PR at a time
pait finalize --single

# Skip verification, use merge commits
pait finalize --no-verify --strategy merge

# Auto-resolve conflicts (non-interactive, for agent workflows)
pait finalize --auto-resolve
```
