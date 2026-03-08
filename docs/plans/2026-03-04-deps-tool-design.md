# Design: `pait deps` — Native GitHub Issue Relationship Management

**Date:** 2026-03-04
**Status:** Approved
**Author:** Ian Hogers + Maple

## Problem

The orchestrator currently parses "depends on #N" from issue body text to build dependency graphs. GitHub has a native relationship system (blocked-by, parent/sub-issue) accessible via GraphQL API, but not exposed through `gh` CLI commands. The text-based approach doesn't show in GitHub's UI and can't be validated programmatically.

## Solution

A standalone `pait deps` tool that manages GitHub issue relationships via the native GraphQL API. It becomes the single source of truth for dependencies, replacing text-based parsing. The orchestrator and finalize tools consume it as a shared service.

## Design Principles

- **SRP:** Each module has one job — API communication, graph logic, display formatting, CLI routing.
- **DIP:** Orchestrator and finalize depend on a `RelationshipService` interface, not the concrete GitHub implementation.
- **DRY:** Reuse `shared/graph.ts` for topological sort, `shared/github.ts` for `gh api` calls, `shared/log.ts` for terminal output.

## CLI Interface

```
pait deps <subcommand> [flags]

Subcommands:
  add       Add a relationship between issues
  remove    Remove a relationship between issues
  list      Show relationships for a specific issue
  tree      Show full dependency tree for all open issues
  validate  Check for problems (cycles, missing deps, orphans)
  sync      Migrate text-based "depends on" to native relationships
```

### `add` / `remove`

```bash
# Blocking relationships
pait deps add --blocks 5 --issue 3       # Issue 3 blocks issue 5
pait deps add --blocked-by 3 --issue 5   # Issue 5 is blocked by issue 3 (same)
pait deps remove --blocks 5 --issue 3

# Parent/child relationships
pait deps add --parent 3 --issue 7       # Issue 7 is a sub-issue of 3
pait deps add --child 7 --issue 3        # Same, other direction
pait deps remove --parent 3 --issue 7
```

### `list`

```
$ pait deps list --issue 5
Issue #5: Implement auth middleware

  Blocked by:
    #3  Set up database schema        (open)
    #4  Define API types               (closed)

  Blocking:
    #8  Add protected routes           (open)

  Parent: #2 Auth system epic
  Sub-issues: (none)
```

### `tree`

```
$ pait deps tree
Dependency tree (12 open issues):

Tier 0 (no dependencies):
  #1  Project setup
  #3  Database schema

Tier 1:
  #4  API types ← #3
  #5  Auth middleware ← #3, #4

Tier 2:
  #8  Protected routes ← #5
  #9  User endpoints ← #5, #4

⚠ Cycle detected: #11 ↔ #12
⚠ Missing dep: #7 depends on #99 (not found)
```

### `validate`

```
$ pait deps validate
✓ 10 issues with valid dependency chains
⚠ 1 cycle: #11 → #12 → #11
⚠ 1 missing dependency: #7 → #99 (issue not found)
⚠ 2 text-based deps not synced to native: #5, #6
```

### `sync`

```bash
# Migrate text-based "depends on #N" to native blocked-by relationships
pait deps sync              # Dry run: show what would be synced
pait deps sync --apply      # Actually create the native relationships
```

## File Structure

```
tools/deps/
  index.ts            — CLI entry: parseFlags, route to subcommands
  types.ts            — Relationship, DepsFlags, RelationshipType
  service.ts          — RelationshipService interface + GitHub implementation
  graph.ts            — Build dependency graph from relationships, topological sort
  display.ts          — Format tree/list/validate output for terminal
  deps.test.ts        — Colocated tests
  README.md           — Usage docs
```

## Key Interfaces

```typescript
// Shared interface — orchestrator and finalize depend on this
interface RelationshipService {
  getRelationships(issueNumber: number): Promise<Result<IssueRelationships, PaiError>>;
  getAllRelationships(): Promise<Result<Map<number, IssueRelationships>, PaiError>>;
  addBlockedBy(issue: number, blockedBy: number): Promise<Result<void, PaiError>>;
  removeBlockedBy(issue: number, blockedBy: number): Promise<Result<void, PaiError>>;
  addSubIssue(parent: number, child: number): Promise<Result<void, PaiError>>;
  removeSubIssue(parent: number, child: number): Promise<Result<void, PaiError>>;
}

interface IssueRelationships {
  number: number;
  title: string;
  state: 'open' | 'closed';
  blockedBy: number[];
  blocking: number[];
  parent: number | null;
  subIssues: number[];
}
```

## GraphQL Operations

### Read (single issue)

```graphql
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      id
      number
      title
      state
      blockedBy(first: 50) { nodes { number title state } }
      blocking(first: 50) { nodes { number title state } }
      parent { number title state }
      subIssues(first: 50) { nodes { number title state } }
    }
  }
}
```

### Read (all open issues with relationships)

```graphql
query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    issues(states: OPEN, first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id number title state
        blockedBy(first: 50) { nodes { number title state } }
        blocking(first: 50) { nodes { number title state } }
        parent { number title state }
        subIssues(first: 50) { nodes { number title state } }
      }
    }
  }
}
```

### Mutations

```graphql
mutation AddBlockedBy($id: ID!, $blockedById: ID!) {
  addBlockedBy(input: { issueId: $id, blockedByIssueId: $blockedById }) {
    clientMutationId
  }
}

mutation RemoveBlockedBy($id: ID!, $blockedById: ID!) {
  removeBlockedBy(input: { issueId: $id, blockedByIssueId: $blockedById }) {
    clientMutationId
  }
}

mutation AddSubIssue($parentId: ID!, $childId: ID!) {
  addSubIssue(input: { issueId: $parentId, childIssueId: $childId }) {
    clientMutationId
  }
}

mutation RemoveSubIssue($parentId: ID!, $childId: ID!) {
  removeSubIssue(input: { issueId: $parentId, childIssueId: $childId }) {
    clientMutationId
  }
}
```

Note: Mutations require the global node ID (`id` field), not the issue number. The service resolves number → ID internally.

## Orchestrator Migration

The orchestrator's `dependency-graph.ts` currently calls `parseDependencies(body)`. After migration:

```typescript
// Before
const deps = parseDependencies(issue.body);

// After
const rels = await depsService.getRelationships(issue.number);
const blockedBy = rels.value.blockedBy;
```

The `buildGraph()` function's `DependencyGraphDeps` interface gains a `service: RelationshipService` member. The text-based `parseDependencies()` becomes dead code and is removed.

The finalize tool similarly switches from reading PR bodies to querying native relationships for merge ordering.

## Sync Command

`pait deps sync` bridges the migration:

1. Fetches all open issues.
2. Parses "depends on #N" from each issue body.
3. Queries native relationships for each issue.
4. Reports mismatches (text dep exists but no native relationship).
5. With `--apply`: creates the missing native relationships via mutations.
6. After all issues are synced, the text-based deps in issue bodies become informational only.

## Shared Code Reuse

| Shared Module | What's Reused |
|---------------|---------------|
| `shared/graph.ts` | `topologicalSort<T>` for dependency ordering |
| `shared/github.ts` | `gh api` execution, repo detection, author filtering |
| `shared/log.ts` | `Spinner`, `log.info/ok/warn/error` |
| `shared/config.ts` | `findRepoRoot()`, `loadToolConfig()` |

## Testing Strategy

- Mock `RelationshipService` for graph and display tests.
- Integration test: use a test fixture repo to verify GraphQL queries work.
- CLI flag parsing tests (required by `cli.test.ts` HELP sync check).
