# Agent Log Streaming

**Date:** 2026-03-04
**Status:** Approved (revised)

## Problem

During pait agent calls (assess, implement, fix-verify), the user sees only a spinner. Claude's output is fully buffered and mostly discarded — `implementIssue` shows the last 500 chars dimmed, the others show nothing. The full output is logged to JSONL but never streamed live.

## Decision

Show a rolling window of the last 10 lines of Claude's output in real-time, plus a link to the full log file. Replaces the spinner as the default behavior.

## Design

### `shared/claude.ts` — `runClaude()`

Add an `onChunk` callback to `RunClaudeOpts`. When provided, each stdout chunk is passed to the callback as it arrives. The callback handles display logic — `runClaude` itself stays simple (tee to buffer + callback).

When no `onChunk` is provided: current behavior (full buffer, no display).

```typescript
export interface RunClaudeOpts {
    prompt: string;
    model: string;
    cwd: string;
    permissionMode?: string;
    allowedTools?: string;
    onChunk?: (chunk: string) => void;
}
```

Return type unchanged: `Promise<{ ok: boolean; output: string }>`.

### `shared/log.ts` — `RollingWindow` class

New class that maintains a ring buffer of the last N lines and redraws them on each update. Uses ANSI escape codes to overwrite the window region.

```
┌─ Agent implementing #42 ──────────────────────────
│ Reading CLAUDE.md for project conventions...
│ Exploring src/auth/ for existing patterns...
│ Writing test for JWT validation...
│ ...
│ Running bun test -- all 12 tests pass
└─ Full log: .pait/logs/2026-03-04T18-00-41.jsonl ──
```

The window:
- Shows a header line with the task description
- Renders the last 10 lines of output (configurable via constructor)
- Shows a footer with the path to the full log file
- Redraws by moving cursor up N+2 lines and overwriting
- On completion, clears the window (like the spinner does today)

### Call site changes

Call sites replace spinner with: (1) print the log file path, (2) pass an `onChunk` callback that feeds a `RollingWindow`, (3) clear the window when done.

| Call site | File | Changes |
|-----------|------|---------|
| `assessIssueSize` | `tools/orchestrator/agent-runner.ts` | Replace spinner with rolling window |
| `implementIssue` | `tools/orchestrator/agent-runner.ts` | Replace spinner + logDim with rolling window |
| `fixVerificationFailure` | `tools/orchestrator/verify-fixer.ts` | Replace spinner with rolling window |

`resolveConflicts` and `autoResolveConflicts` in `shared/git.ts` — pass `onChunk` to show a rolling window during conflict resolution. These calls go through `deps.claude()` which already accepts `RunClaudeOpts`.

### What stays the same

- `ClaudeProcess` interface (stdout still piped)
- Return type `{ ok: boolean; output: string }`
- JSONL logging via `logger.agentOutput()`
- stderr handling (captured, discarded)
- JSON parsing in `assessIssueSize` (works on full buffered output)

### Deps/Testing

`RollingWindow` takes a `LogDeps`-compatible object for output. Tests inject a mock writer.

`runClaude` tests verify that `onChunk` is called with decoded text chunks.

## Files to modify

1. `shared/claude.ts` — `onChunk` callback in read loop
2. `shared/log.ts` — new `RollingWindow` class
3. `tools/orchestrator/agent-runner.ts` — replace spinner with rolling window
4. `tools/orchestrator/verify-fixer.ts` — replace spinner with rolling window
5. `shared/git.ts` — pass `onChunk` to `deps.claude()` in `resolveConflicts` and `autoResolveConflicts`
6. Tests for all above
