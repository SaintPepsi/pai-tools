# Agent Log Streaming

**Date:** 2026-03-04
**Status:** Approved

## Problem

During pait agent calls (assess, implement, fix-verify), the user sees only a spinner. Claude's output is fully buffered and mostly discarded — `implementIssue` shows the last 500 chars dimmed, the others show nothing. The full output is logged to JSONL but never streamed live.

## Decision

Stream Claude's stdout to the terminal in real-time during all agent calls. Raw passthrough, no formatting. This replaces the spinner as the default behavior.

## Design

### `shared/claude.ts` — `runClaude()`

Add `stream?: boolean` to `RunClaudeOpts` (default `true`).

When streaming: read stdout chunk-by-chunk via async iteration. Each chunk is written to `process.stdout` immediately and appended to a buffer. After the process exits, return the full buffered output as before.

When `stream: false`: current behavior (full buffer, no display).

Add `stdout: { write: (chunk: Uint8Array | string) => void }` to `ClaudeDeps` for testability. Default: `process.stdout`.

Return type unchanged: `Promise<{ ok: boolean; output: string }>`.

### Call site changes

All call sites remove their spinner usage. The streaming output replaces the spinner as live feedback.

| Call site | File | Changes |
|-----------|------|---------|
| `assessIssueSize` | `tools/orchestrator/agent-runner.ts` | Remove spinner start/stop |
| `implementIssue` | `tools/orchestrator/agent-runner.ts` | Remove spinner start/stop, remove `logDim(output.slice(-500))` |
| `fixVerificationFailure` | `tools/orchestrator/verify-fixer.ts` | Remove spinner start/stop |
| `autoResolveConflicts` | `shared/git.ts` | Remove spinner for Claude call |

### What stays the same

- `ClaudeProcess` interface (stdout still piped)
- Return type `{ ok: boolean; output: string }`
- JSONL logging via `logger.agentOutput()`
- stderr handling (captured, discarded)
- JSON parsing in `assessIssueSize` (works on full buffered output)

### Deps/Testing

`ClaudeDeps` gains a `stdout` member. Tests inject a mock writer to capture or suppress streamed output without hitting the real terminal.

## Files to modify

1. `shared/claude.ts` — streaming tee logic, new `stream` option, `stdout` dep
2. `tools/orchestrator/agent-runner.ts` — remove spinner from assess and implement
3. `tools/orchestrator/verify-fixer.ts` — remove spinner from fix-verify
4. `shared/git.ts` — remove spinner from autoResolveConflicts Claude call
5. Tests for all above
