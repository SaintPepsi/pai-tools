# Implementation Plan
#
# Combined plan for agent log streaming and deps tool.
# Run: `pait orchestrate --file PLAN.md`
#
# Rules:
#   - [ ] Unchecked items become tasks (orchestrated in order)
#   - [x] Checked items are skipped (treated as already done)
#   - Indented sub-items fold into the parent task as acceptance criteria
#   - ## Headings become labels on the generated tasks
#   - "depends on #N" creates a dependency (N = sequential item number)
#   - Bold (**text**) and inline code (`text`) are stripped from titles

## Agent Log Streaming

- [ ] Add `onChunk` callback to `runClaude()` in `shared/claude.ts`
  - [ ] Add `onChunk?: (chunk: string) => void` to `RunClaudeOpts`
  - [ ] Replace buffered stdout read with streaming `for await` loop
  - [ ] Call `onChunk` with decoded text for each chunk
  - [ ] Still return full buffered output in the result
  - [ ] Add tests in `shared/claude.test.ts` for onChunk behavior
- [ ] Create `RollingWindow` class in `shared/log.ts`
  - [ ] Ring buffer of last N lines (default 10)
  - [ ] `update(text)` splits multiline chunks and adds to buffer
  - [ ] `clear()` removes window from terminal via ANSI escapes
  - [ ] `getLines()` returns current buffer contents
  - [ ] Header line with task description and footer with log file path
  - [ ] Redraws by moving cursor up and overwriting
  - [ ] Deps injected via `RollingWindowDeps` interface
  - [ ] Add tests in `shared/log.test.ts` for RollingWindow
- [ ] Wire rolling window into `agent-runner.ts` (depends on #1, #2)
  - [ ] Replace `makeSpinner` with `makeWindow` in `AgentRunnerDeps`
  - [ ] Update `assessIssueSize` to use rolling window with onChunk
  - [ ] Update `implementIssue` to use rolling window with onChunk
  - [ ] Remove `logDim` call for last 500 chars of output
  - [ ] Update tests in `agent-runner.coverage.test.ts`
- [ ] Wire rolling window into `verify-fixer.ts` (depends on #1, #2)
  - [ ] Replace `makeSpinner` with `makeWindow` in `VerifyFixerDeps`
  - [ ] Update `fixVerificationFailure` to use rolling window with onChunk
  - [ ] Remove `spinnerLabel` from `FixVerificationOptions`
  - [ ] Update tests in `verify-fixer.coverage.test.ts`
- [ ] Wire rolling window into `shared/git.ts` conflict resolution (depends on #1, #2)
  - [ ] Add `makeWindow` to `GitDeps` interface
  - [ ] Pass onChunk to `deps.claude()` in `resolveConflicts`
  - [ ] Pass onChunk to `deps.claude()` in `autoResolveConflicts`
  - [ ] Update all mock `GitDeps` in `shared/git.test.ts`
- [ ] Clean up stale spinner references and run full test suite (depends on #3, #4, #5)
  - [ ] Search for and remove stale `spinnerLabel` and `makeSpinner` references
  - [ ] Verify no orchestrator files import `Spinner` directly
  - [ ] Run `bun test` — all tests pass
  - [ ] Run `bun build --target bun --outfile /tmp/pait-check cli.ts` — no type errors

## Deps Tool

- [ ] Create types and interfaces in `tools/deps/types.ts`
  - [ ] `IssueRef` with number, title, state
  - [ ] `IssueRelationships` with id, number, title, state, blockedBy, blocking, parent, subIssues
  - [ ] `RelationshipService` interface with CRUD methods
  - [ ] `DepsSubcommand` union type
  - [ ] `DepsFlags` interface with all CLI flags
  - [ ] `DepsDeps` interface for dependency injection
- [ ] Create flag parsing in `tools/deps/flags.ts` (depends on #7)
  - [ ] `parseDepsFlags` handles add, remove, list, tree, validate, sync subcommands
  - [ ] Parses `--issue`, `--blocks`, `--blocked-by`, `--parent`, `--child` numeric flags
  - [ ] Parses `--apply`, `--json`, `--help` boolean flags
  - [ ] Returns null subcommand for empty args
  - [ ] Add tests in `tools/deps/flags.test.ts`
- [ ] Create GraphQL service in `tools/deps/service.ts` (depends on #7)
  - [ ] `GitHubRelationshipService` implements `RelationshipService`
  - [ ] `getRelationships` queries single issue via GraphQL
  - [ ] `getAllRelationships` paginates all open issues
  - [ ] `addBlockedBy` and `removeBlockedBy` resolve IDs and mutate
  - [ ] `addSubIssue` and `removeSubIssue` resolve IDs and mutate
  - [ ] `resolveIssueId` converts issue number to node ID
  - [ ] Add tests in `tools/deps/service.test.ts`
- [ ] Create graph building and validation in `tools/deps/graph.ts` (depends on #7)
  - [ ] `buildDepsGraph` creates adjacency map from relationships
  - [ ] `validateGraph` detects cycles via DFS
  - [ ] `validateGraph` detects missing dependencies
  - [ ] `computeTiers` groups issues into parallelizable execution tiers
  - [ ] Add tests in `tools/deps/graph.test.ts`
- [ ] Create display formatting in `tools/deps/display.ts` (depends on #10)
  - [ ] `formatList` renders relationships for a single issue
  - [ ] `formatTree` renders tiered dependency tree with issue titles
  - [ ] `formatValidation` renders cycle and missing dep warnings
  - [ ] Omit empty sections in list output
  - [ ] Add tests in `tools/deps/display.test.ts`
- [ ] Create CLI entry point in `tools/deps/index.ts` and wire into `cli.ts` (depends on #8, #9, #10, #11)
  - [ ] Route subcommands to handler functions
  - [ ] `handleAdd` and `handleRemove` call service mutations
  - [ ] `handleList`, `handleTree`, `handleValidate` format and output results
  - [ ] `handleSync` bridges text-based deps to native relationships
  - [ ] Add `deps` command to `cli.ts` commands Map
  - [ ] Add deps command and flags to HELP string in `cli.ts`
- [ ] Add README and update HELP sync tests (depends on #12)
  - [ ] Write `tools/deps/README.md` with usage docs
  - [ ] Add deps flag sync test to `cli.test.ts`
  - [ ] Add deps to tool README flag sync test suite
  - [ ] Run `bun test` — all tests pass
- [ ] End-to-end smoke test (depends on #12)
  - [ ] `bun run cli.ts deps --help` shows help text
  - [ ] `bun run cli.ts deps tree` fetches and displays dependency tree
  - [ ] `bun run cli.ts deps list --issue 1` shows issue relationships
  - [ ] `bun run cli.ts deps validate` shows validation results
  - [ ] Run `bun test` — full suite passes
