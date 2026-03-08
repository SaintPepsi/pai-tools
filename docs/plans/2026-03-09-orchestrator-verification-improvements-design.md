# Orchestrator Verification & State Management Improvements

## Problem

The orchestrator has 7 gaps identified from production usage:

1. **Split issues block dependents indefinitely** — Parent stays in `split` status forever. Dependents fail with "Unmet dependencies" even after all sub-issues merge.
2. **Verification is build-only** — tsc/vitest/lint/build pass but don't check whether acceptance criteria were actually met. A 15-line type-only diff passes verification for a full feature issue.
3. **No diff size/substance check** — No heuristic catches hollow implementations.
4. **State gets stale** — Manual interventions (closing PRs/issues) aren't reflected in orchestrator state.
5. **No post-merge cleanup of split tracking** — Split status has no completion condition.
6. **Zero-diff detection missing** — Agent produces no code changes, verification passes (clean repo), PR creation fails on no commits.
7. **Agent prompt allows design-only output** — Agent sometimes treats issues as design discussions instead of implementation tasks.

## Principles

**Programmatic over agent:** If a check can be done without an LLM call, do it programmatically. Only use an agent when the task requires natural language understanding (e.g., comparing a diff against prose acceptance criteria). Deterministic checks are faster, cheaper, and more reliable.

## Design

### 1. Zero-diff detection

**Location:** `execution.ts`, between agent implementation and verification.

After the agent completes, run `git diff --stat ${baseBranch}` in the worktree. If no changes exist, mark the issue as `failed` with error "Agent produced no changes" and skip verification entirely. This is the cheapest check and catches the most egregious failure mode.

### 2. Agent prompt enforcement

**Location:** `agent-runner.ts`, `buildImplementationPrompt()`.

Add explicit instructions to the agent prompt:

```
CRITICAL: You MUST write code and make commits. Do not ask clarifying questions.
Do not propose designs or alternatives. Do not output analysis without implementation.
If requirements are ambiguous, make reasonable assumptions and implement.
```

### 3. Requirements verification (post-verify LLM gate)

**Location:** New file `tools/orchestrator/requirements-check.ts`. Called from `execution.ts` after verify passes, before PR creation.

**Flow:**
1. Get `git diff ${baseBranch}...HEAD` in worktree
2. Compute diff metrics (lines changed, files changed, file types)
3. Extract acceptance criteria count from issue body (count `- [ ]` checkboxes or numbered items)
4. Send diff + issue body + metrics to Claude with structured prompt asking for JSON assessment
5. If `satisfied: false`, invoke fix agent with assessment feedback (same retry pattern as verify-fixer)
6. Retry using existing `withRetries` pattern

**New config:** `retries.requirements` (default: 1) in orchestrator config.

**Prompt structure:**
```
Given this GitHub issue and the git diff, assess whether the implementation
satisfies the requirements. Return JSON:
{
  satisfied: boolean,
  criteria: [{criterion: string, met: boolean, evidence: string}],
  summary: string
}
```

### 4. Diff substance heuristic

**Location:** Part of `requirements-check.ts`, computed before the LLM call.

Metrics computed from the diff:
- Total lines added/removed
- Number of files changed
- File types (`.ts` vs `.d.ts` vs `.test.ts`)
- Acceptance criteria count from issue body

If ratio is suspicious (e.g., <20 lines changed but >5 acceptance criteria), add a warning to the LLM prompt: "Note: the diff is unusually small relative to the issue scope. Assess critically."

Not a hard block on its own — feeds into the LLM assessment as additional context.

### 5. Split parent auto-close

**Location:** `state-helpers.ts` (new function) + `execution.ts` (call site).

New function `checkSplitParentCompletion(state, completedIssueNumber)`:
1. After any issue completes, check if it's a sub-issue of a split parent
2. Find the parent by scanning state for issues with `status='split'` whose `subIssues` array contains this issue number
3. If all `subIssues` of the parent are `completed`, mark parent as `completed` with `completedAt=now`
4. Close the parent GitHub issue via `gh issue close`

Called at the end of the per-issue success path in `execution.ts`.

### 6. State reconciliation at startup

**Location:** `state-helpers.ts` (new function) + `execution.ts` (call site at startup).

New function `reconcileWithGitHub(state, repoRoot)`:
- Called once at orchestrator startup, before the execution loop
- For each issue in state:
  - `completed` with `prNumber`: check `gh pr view --json state` — if PR was closed without merge, reset to `failed`
  - `split` with `subIssues`: check each sub-issue's GitHub state — if all closed, mark parent `completed`
  - `in_progress`: check if branch exists via `git branch --list` — if not, reset to `pending`
- Logs all corrections made

### 7. Agent prompt enforcement

Covered in section 2 above.

## Architecture

```
execution.ts (per-issue pipeline)
├── dependency check
├── size assessment → split if needed
├── worktree creation
├── agent implementation (with retries)
├── NEW: zero-diff check ← fails fast if no changes
├── verification (tsc, lint, test, build)
├── NEW: requirements check (LLM gate) ← fails if criteria unmet
│   └── diff substance heuristic (feeds into LLM prompt)
├── PR creation
└── NEW: split parent completion check

execution.ts (startup)
└── NEW: state reconciliation with GitHub
```

## Files Modified

| File | Change |
|------|--------|
| `tools/orchestrator/execution.ts` | Zero-diff check, requirements gate call site, split completion call site, startup reconciliation call |
| `tools/orchestrator/agent-runner.ts` | Prompt enforcement text |
| `tools/orchestrator/requirements-check.ts` | **New file** — LLM requirements assessment + diff substance heuristic |
| `tools/orchestrator/state-helpers.ts` | `checkSplitParentCompletion()`, `reconcileWithGitHub()` |
| `tools/orchestrator/types.ts` | `retries.requirements` config field |
| `tools/orchestrator/defaults.ts` | Default value for `retries.requirements` |

## Testing

Each improvement gets colocated tests:
- `requirements-check.test.ts` — mock Claude responses, test pass/fail/retry flow, test diff metrics extraction
- `state-helpers.test.ts` — extend existing tests for split completion and reconciliation
- `execution.test.ts` — extend for zero-diff detection integration

## Priority Order (implementation)

1. Zero-diff detection — trivial, immediate value
2. Agent prompt enforcement — one-line change
3. Split parent auto-close — straightforward state logic
4. State reconciliation — moderate, needs `gh` CLI mocking in tests
5. Requirements verification + diff substance — most complex, new module
