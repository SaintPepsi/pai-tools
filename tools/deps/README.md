# pait deps

Manage GitHub issue dependency relationships using native GitHub relationship APIs.

## Usage

```
pait deps <subcommand> [flags]
```

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `add`      | Add a dependency relationship between issues |
| `remove`   | Remove a dependency relationship between issues |
| `list`     | List dependency relationships for an issue |
| `tree`     | Show the full dependency tree for all open issues |
| `validate` | Check for cycles or inconsistencies in the graph |
| `sync`     | Sync text-based dep mentions to native GitHub relationships |

## Flags

| Flag | Description |
|------|-------------|
| `--issue <N>` | Target issue number |
| `--blocks <N>` | Issue that the target issue blocks |
| `--blocked-by <N>` | Issue that blocks the target issue |
| `--parent <N>` | Parent issue number (sets a sub-issue relationship) |
| `--child <N>` | Child/sub-issue number |
| `--apply` | Apply pending changes without prompting |
| `--json` | Output as JSON instead of terminal format |
| `--help`, `-h` | Show help message |

## Examples

```bash
# Add relationships
pait deps add --issue 12 --blocked-by 10
pait deps add --issue 12 --blocks 15
pait deps add --issue 12 --parent 5

# Remove relationships
pait deps remove --issue 12 --blocked-by 10

# Inspect
pait deps list --issue 12
pait deps tree
pait deps tree --json

# Validate
pait deps validate

# Sync text-based deps from issue bodies to native relationships
pait deps sync           # preview what would be synced
pait deps sync --apply   # actually create the relationships
```

## Sync Behaviour

The `sync` subcommand scans all open issue bodies for text patterns:

- `Depends on #N`
- `Blocked by #N`
- `Requires #N`

Any found relationships not already recorded as native GitHub relationships are shown as pending. Pass `--apply` to create them.

## Config

No per-project config. Reads repo info from `gh repo view`.
