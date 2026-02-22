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
├── shared/
│   ├── log.ts                      # Colored terminal logging
│   ├── claude.ts                   # Claude CLI helper (stdin piping)
│   └── config.ts                   # .pai/ discovery, config loading, state paths
└── tools/
    └── orchestrator/
        ├── README.md               # Orchestrator docs, config, usage
        ├── index.ts                # Main orchestration logic
        ├── types.ts                # TypeScript interfaces
        └── defaults.ts             # Default config values
```

## Requirements

- [Bun](https://bun.sh)
- [GitHub CLI](https://cli.github.com) (`gh`)
- [Claude Code](https://claude.ai/code) (`claude`)
