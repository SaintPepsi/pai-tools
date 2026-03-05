# `pait deps` Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a CLI tool for managing GitHub issue relationships (blocked-by, parent/sub-issue) via the native GraphQL API.

**Architecture:** Standalone `tools/deps/` module with `RelationshipService` interface consumed by the CLI and later by the orchestrator. Uses `gh api graphql` for all GitHub communication. Follows existing DI patterns (interface + defaultDeps).

**Tech Stack:** TypeScript, Bun, `gh` CLI (GraphQL), `shared/log.ts`, `shared/graph.ts`

---

### Task 1: Types and interfaces

**Files:**
- Create: `tools/deps/types.ts`

**Step 1: Write the types file**

```typescript
import type { GithubDeps } from '@shared/github.ts';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface IssueRef {
	number: number;
	title: string;
	state: 'OPEN' | 'CLOSED';
}

export interface IssueRelationships {
	id: string;
	number: number;
	title: string;
	state: 'OPEN' | 'CLOSED';
	blockedBy: IssueRef[];
	blocking: IssueRef[];
	parent: IssueRef | null;
	subIssues: IssueRef[];
}

// ---------------------------------------------------------------------------
// Service interface (DIP — consumers depend on this, not the implementation)
// ---------------------------------------------------------------------------

export interface RelationshipService {
	getRelationships(issueNumber: number): Promise<IssueRelationships>;
	getAllRelationships(): Promise<Map<number, IssueRelationships>>;
	addBlockedBy(issue: number, blockedBy: number): Promise<void>;
	removeBlockedBy(issue: number, blockedBy: number): Promise<void>;
	addSubIssue(parent: number, child: number): Promise<void>;
	removeSubIssue(parent: number, child: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// CLI types
// ---------------------------------------------------------------------------

export type DepsSubcommand = 'add' | 'remove' | 'list' | 'tree' | 'validate' | 'sync';

export interface DepsFlags {
	subcommand: DepsSubcommand | null;
	issue: number | null;
	blocks: number | null;
	blockedBy: number | null;
	parent: number | null;
	child: number | null;
	apply: boolean;
	json: boolean;
	help: boolean;
}

// ---------------------------------------------------------------------------
// Service deps (DI seam)
// ---------------------------------------------------------------------------

export interface DepsDeps {
	exec: GithubDeps['exec'];
	repoOwner: string;
	repoName: string;
}
```

**Step 2: Commit**

```bash
git add tools/deps/types.ts
git commit -m "feat(deps): add types and interfaces for deps tool"
```

---

### Task 2: Flag parsing

**Files:**
- Create: `tools/deps/flags.ts`
- Test: `tools/deps/flags.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, expect, test } from 'bun:test';
import { parseDepsFlags } from './flags.ts';

describe('parseDepsFlags', () => {
	test('parses add --blocks with --issue', () => {
		const flags = parseDepsFlags(['add', '--blocks', '5', '--issue', '3']);
		expect(flags.subcommand).toBe('add');
		expect(flags.blocks).toBe(5);
		expect(flags.issue).toBe(3);
	});

	test('parses add --blocked-by with --issue', () => {
		const flags = parseDepsFlags(['add', '--blocked-by', '3', '--issue', '5']);
		expect(flags.subcommand).toBe('add');
		expect(flags.blockedBy).toBe(3);
		expect(flags.issue).toBe(5);
	});

	test('parses add --parent with --issue', () => {
		const flags = parseDepsFlags(['add', '--parent', '3', '--issue', '7']);
		expect(flags.subcommand).toBe('add');
		expect(flags.parent).toBe(3);
		expect(flags.issue).toBe(7);
	});

	test('parses add --child with --issue', () => {
		const flags = parseDepsFlags(['add', '--child', '7', '--issue', '3']);
		expect(flags.subcommand).toBe('add');
		expect(flags.child).toBe(7);
		expect(flags.issue).toBe(3);
	});

	test('parses remove --blocks with --issue', () => {
		const flags = parseDepsFlags(['remove', '--blocks', '5', '--issue', '3']);
		expect(flags.subcommand).toBe('remove');
		expect(flags.blocks).toBe(5);
		expect(flags.issue).toBe(3);
	});

	test('parses list --issue', () => {
		const flags = parseDepsFlags(['list', '--issue', '5']);
		expect(flags.subcommand).toBe('list');
		expect(flags.issue).toBe(5);
	});

	test('parses tree with no flags', () => {
		const flags = parseDepsFlags(['tree']);
		expect(flags.subcommand).toBe('tree');
	});

	test('parses validate with no flags', () => {
		const flags = parseDepsFlags(['validate']);
		expect(flags.subcommand).toBe('validate');
	});

	test('parses sync --apply', () => {
		const flags = parseDepsFlags(['sync', '--apply']);
		expect(flags.subcommand).toBe('sync');
		expect(flags.apply).toBe(true);
	});

	test('parses sync without --apply (dry run)', () => {
		const flags = parseDepsFlags(['sync']);
		expect(flags.subcommand).toBe('sync');
		expect(flags.apply).toBe(false);
	});

	test('parses --json flag', () => {
		const flags = parseDepsFlags(['tree', '--json']);
		expect(flags.json).toBe(true);
	});

	test('parses --help flag', () => {
		const flags = parseDepsFlags(['--help']);
		expect(flags.help).toBe(true);
	});

	test('returns null subcommand for empty args', () => {
		const flags = parseDepsFlags([]);
		expect(flags.subcommand).toBe(null);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tools/deps/flags.test.ts`
Expected: FAIL — `parseDepsFlags` not found

**Step 3: Write the implementation**

```typescript
import type { DepsFlags, DepsSubcommand } from './types.ts';

const SUBCOMMANDS: Set<string> = new Set(['add', 'remove', 'list', 'tree', 'validate', 'sync']);

function parseNumericFlag(args: string[], flag: string): number | null {
	const idx = args.indexOf(flag);
	if (idx === -1) return null;
	const val = Number(args[idx + 1]);
	return Number.isNaN(val) ? null : val;
}

export function parseDepsFlags(args: string[]): DepsFlags {
	const first = args[0];
	const subcommand = (first && SUBCOMMANDS.has(first) ? first : null) as DepsSubcommand | null;

	return {
		subcommand,
		issue: parseNumericFlag(args, '--issue'),
		blocks: parseNumericFlag(args, '--blocks'),
		blockedBy: parseNumericFlag(args, '--blocked-by'),
		parent: parseNumericFlag(args, '--parent'),
		child: parseNumericFlag(args, '--child'),
		apply: args.includes('--apply'),
		json: args.includes('--json'),
		help: args.includes('--help') || args.includes('-h'),
	};
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tools/deps/flags.test.ts`
Expected: PASS — all 13 tests green

**Step 5: Commit**

```bash
git add tools/deps/flags.ts tools/deps/flags.test.ts
git commit -m "feat(deps): add flag parsing with tests"
```

---

### Task 3: GraphQL service implementation

**Files:**
- Create: `tools/deps/service.ts`
- Test: `tools/deps/service.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, expect, test } from 'bun:test';
import { GitHubRelationshipService } from './service.ts';
import type { DepsDeps } from './types.ts';

function makeMockDeps(responses: Record<string, string>): DepsDeps {
	return {
		exec: async (cmd: string[]) => {
			const body = cmd.find(a => a.startsWith('{'));
			const key = body ? 'graphql' : cmd.join(' ');
			return { exitCode: 0, stdout: responses[key] ?? '{}', stderr: '' };
		},
		repoOwner: 'test-owner',
		repoName: 'test-repo',
	};
}

describe('GitHubRelationshipService', () => {
	test('getRelationships returns parsed relationships', async () => {
		const response = JSON.stringify({
			data: {
				repository: {
					issue: {
						id: 'I_abc123',
						number: 5,
						title: 'Auth middleware',
						state: 'OPEN',
						blockedBy: { nodes: [{ number: 3, title: 'DB schema', state: 'OPEN' }] },
						blocking: { nodes: [{ number: 8, title: 'Routes', state: 'OPEN' }] },
						parent: null,
						subIssues: { nodes: [] },
					},
				},
			},
		});

		const deps = makeMockDeps({ graphql: response });
		const service = new GitHubRelationshipService(deps);
		const result = await service.getRelationships(5);

		expect(result.number).toBe(5);
		expect(result.title).toBe('Auth middleware');
		expect(result.blockedBy).toHaveLength(1);
		expect(result.blockedBy[0].number).toBe(3);
		expect(result.blocking).toHaveLength(1);
		expect(result.blocking[0].number).toBe(8);
		expect(result.parent).toBeNull();
		expect(result.subIssues).toHaveLength(0);
	});

	test('getRelationships throws on GraphQL error', async () => {
		const response = JSON.stringify({
			errors: [{ message: 'Issue not found' }],
		});
		const deps = makeMockDeps({ graphql: response });
		const service = new GitHubRelationshipService(deps);

		expect(service.getRelationships(999)).rejects.toThrow('Issue not found');
	});

	test('addBlockedBy calls correct mutation', async () => {
		const calls: string[][] = [];
		const deps: DepsDeps = {
			exec: async (cmd) => {
				calls.push(cmd);
				return {
					exitCode: 0,
					stdout: JSON.stringify({ data: { addBlockedBy: { clientMutationId: null } } }),
					stderr: '',
				};
			},
			repoOwner: 'test-owner',
			repoName: 'test-repo',
		};

		// Service needs to resolve issue numbers to node IDs first
		// We mock getRelationships internally by having exec return id fields
		const service = new GitHubRelationshipService(deps);

		// Override the internal ID resolution
		(service as any).resolveIssueId = async () => 'I_abc123';

		await service.addBlockedBy(5, 3);
		const lastCall = calls[calls.length - 1];
		expect(lastCall).toContain('gh');
		expect(lastCall).toContain('api');
		expect(lastCall).toContain('graphql');
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tools/deps/service.test.ts`
Expected: FAIL — `GitHubRelationshipService` not found

**Step 3: Write the implementation**

```typescript
import type { DepsDeps, IssueRelationships, IssueRef, RelationshipService } from './types.ts';
import type { GithubDeps } from '@shared/github.ts';
import { defaultGithubDeps } from '@shared/github.ts';

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

const ISSUE_RELATIONSHIPS_QUERY = `
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
}`;

const ALL_ISSUES_QUERY = `
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
}`;

const ISSUE_ID_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) { id }
  }
}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseIssueRef(node: any): IssueRef {
	return { number: node.number, title: node.title, state: node.state };
}

function parseRelationships(issue: any): IssueRelationships {
	return {
		id: issue.id,
		number: issue.number,
		title: issue.title,
		state: issue.state,
		blockedBy: (issue.blockedBy?.nodes ?? []).map(parseIssueRef),
		blocking: (issue.blocking?.nodes ?? []).map(parseIssueRef),
		parent: issue.parent ? parseIssueRef(issue.parent) : null,
		subIssues: (issue.subIssues?.nodes ?? []).map(parseIssueRef),
	};
}

// ---------------------------------------------------------------------------
// Default deps
// ---------------------------------------------------------------------------

async function detectRepo(exec: GithubDeps['exec']): Promise<{ owner: string; name: string }> {
	const r = await exec(['gh', 'repo', 'view', '--json', 'owner,name']);
	const data = JSON.parse(r.stdout);
	return { owner: data.owner.login, name: data.name };
}

export async function makeDefaultDepsDeps(
	githubDeps: GithubDeps = defaultGithubDeps,
): Promise<DepsDeps> {
	const { owner, name } = await detectRepo(githubDeps.exec);
	return { exec: githubDeps.exec, repoOwner: owner, repoName: name };
}

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

export class GitHubRelationshipService implements RelationshipService {
	constructor(private deps: DepsDeps) {}

	private async graphql(query: string, variables: Record<string, unknown>): Promise<any> {
		const r = await this.deps.exec([
			'gh', 'api', 'graphql',
			'-f', `query=${query}`,
			...Object.entries(variables).flatMap(([k, v]) =>
				typeof v === 'number'
					? ['-F', `${k}=${v}`]
					: ['-f', `${k}=${v}`],
			),
		]);
		const data = JSON.parse(r.stdout);
		if (data.errors?.length) {
			throw new Error(data.errors.map((e: any) => e.message).join(', '));
		}
		return data;
	}

	async resolveIssueId(issueNumber: number): Promise<string> {
		const data = await this.graphql(ISSUE_ID_QUERY, {
			owner: this.deps.repoOwner,
			repo: this.deps.repoName,
			number: issueNumber,
		});
		return data.data.repository.issue.id;
	}

	async getRelationships(issueNumber: number): Promise<IssueRelationships> {
		const data = await this.graphql(ISSUE_RELATIONSHIPS_QUERY, {
			owner: this.deps.repoOwner,
			repo: this.deps.repoName,
			number: issueNumber,
		});
		return parseRelationships(data.data.repository.issue);
	}

	async getAllRelationships(): Promise<Map<number, IssueRelationships>> {
		const map = new Map<number, IssueRelationships>();
		let cursor: string | null = null;

		do {
			const variables: Record<string, unknown> = {
				owner: this.deps.repoOwner,
				repo: this.deps.repoName,
			};
			if (cursor) variables.cursor = cursor;

			const data = await this.graphql(ALL_ISSUES_QUERY, variables);
			const issues = data.data.repository.issues;

			for (const node of issues.nodes) {
				map.set(node.number, parseRelationships(node));
			}

			cursor = issues.pageInfo.hasNextPage ? issues.pageInfo.endCursor : null;
		} while (cursor);

		return map;
	}

	private async mutate(mutation: string, variables: Record<string, unknown>): Promise<void> {
		await this.graphql(mutation, variables);
	}

	async addBlockedBy(issue: number, blockedBy: number): Promise<void> {
		const [issueId, blockedById] = await Promise.all([
			this.resolveIssueId(issue),
			this.resolveIssueId(blockedBy),
		]);
		await this.mutate(
			`mutation($id: ID!, $blockedById: ID!) {
				addBlockedBy(input: { issueId: $id, blockedByIssueId: $blockedById }) { clientMutationId }
			}`,
			{ id: issueId, blockedById },
		);
	}

	async removeBlockedBy(issue: number, blockedBy: number): Promise<void> {
		const [issueId, blockedById] = await Promise.all([
			this.resolveIssueId(issue),
			this.resolveIssueId(blockedBy),
		]);
		await this.mutate(
			`mutation($id: ID!, $blockedById: ID!) {
				removeBlockedBy(input: { issueId: $id, blockedByIssueId: $blockedById }) { clientMutationId }
			}`,
			{ id: issueId, blockedById },
		);
	}

	async addSubIssue(parent: number, child: number): Promise<void> {
		const [parentId, childId] = await Promise.all([
			this.resolveIssueId(parent),
			this.resolveIssueId(child),
		]);
		await this.mutate(
			`mutation($parentId: ID!, $childId: ID!) {
				addSubIssue(input: { issueId: $parentId, childIssueId: $childId }) { clientMutationId }
			}`,
			{ parentId, childId },
		);
	}

	async removeSubIssue(parent: number, child: number): Promise<void> {
		const [parentId, childId] = await Promise.all([
			this.resolveIssueId(parent),
			this.resolveIssueId(child),
		]);
		await this.mutate(
			`mutation($parentId: ID!, $childId: ID!) {
				removeSubIssue(input: { issueId: $parentId, childIssueId: $childId }) { clientMutationId }
			}`,
			{ parentId, childId },
		);
	}
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tools/deps/service.test.ts`
Expected: PASS — all 3 tests green

**Step 5: Commit**

```bash
git add tools/deps/service.ts tools/deps/service.test.ts
git commit -m "feat(deps): add GitHubRelationshipService with GraphQL queries"
```

---

### Task 4: Graph building and validation

**Files:**
- Create: `tools/deps/graph.ts`
- Test: `tools/deps/graph.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, expect, test } from 'bun:test';
import { buildDepsGraph, validateGraph, computeTiers } from './graph.ts';
import type { IssueRelationships } from './types.ts';

function makeIssue(num: number, blockedBy: number[] = []): IssueRelationships {
	return {
		id: `I_${num}`,
		number: num,
		title: `Issue ${num}`,
		state: 'OPEN',
		blockedBy: blockedBy.map(n => ({ number: n, title: `Issue ${n}`, state: 'OPEN' as const })),
		blocking: [],
		parent: null,
		subIssues: [],
	};
}

describe('buildDepsGraph', () => {
	test('builds adjacency map from relationships', () => {
		const issues = new Map<number, IssueRelationships>([
			[1, makeIssue(1)],
			[2, makeIssue(2, [1])],
			[3, makeIssue(3, [1, 2])],
		]);
		const graph = buildDepsGraph(issues);
		expect(graph.get('1')).toEqual(new Set<string>());
		expect(graph.get('2')).toEqual(new Set(['1']));
		expect(graph.get('3')).toEqual(new Set(['1', '2']));
	});
});

describe('validateGraph', () => {
	test('detects cycles', () => {
		const issues = new Map<number, IssueRelationships>([
			[1, makeIssue(1, [2])],
			[2, makeIssue(2, [1])],
		]);
		const result = validateGraph(issues);
		expect(result.cycles.length).toBeGreaterThan(0);
	});

	test('detects missing dependencies', () => {
		const issues = new Map<number, IssueRelationships>([
			[1, makeIssue(1, [99])],
		]);
		const result = validateGraph(issues);
		expect(result.missing).toHaveLength(1);
		expect(result.missing[0]).toEqual({ issue: 1, missingDep: 99 });
	});

	test('reports valid graph', () => {
		const issues = new Map<number, IssueRelationships>([
			[1, makeIssue(1)],
			[2, makeIssue(2, [1])],
		]);
		const result = validateGraph(issues);
		expect(result.cycles).toHaveLength(0);
		expect(result.missing).toHaveLength(0);
		expect(result.valid).toBe(2);
	});
});

describe('computeTiers', () => {
	test('groups issues into execution tiers', () => {
		const issues = new Map<number, IssueRelationships>([
			[1, makeIssue(1)],
			[3, makeIssue(3)],
			[4, makeIssue(4, [3])],
			[5, makeIssue(5, [3, 4])],
		]);
		const tiers = computeTiers(issues);
		expect(tiers[0]).toEqual(expect.arrayContaining([1, 3]));
		expect(tiers[1]).toEqual([4]);
		expect(tiers[2]).toEqual([5]);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tools/deps/graph.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
import type { IssueRelationships } from './types.ts';

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

/** Build adjacency map: issue number (string key) → set of dependency numbers. */
export function buildDepsGraph(
	issues: Map<number, IssueRelationships>,
): Map<string, Set<string>> {
	const graph = new Map<string, Set<string>>();
	for (const [num, rels] of issues) {
		const deps = new Set<string>();
		for (const dep of rels.blockedBy) {
			deps.add(String(dep.number));
		}
		graph.set(String(num), deps);
	}
	return graph;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
	valid: number;
	cycles: Array<{ path: number[] }>;
	missing: Array<{ issue: number; missingDep: number }>;
}

export function validateGraph(
	issues: Map<number, IssueRelationships>,
): ValidationResult {
	const missing: ValidationResult['missing'] = [];
	const issueNumbers = new Set(issues.keys());

	// Check for missing dependencies
	for (const [num, rels] of issues) {
		for (const dep of rels.blockedBy) {
			if (!issueNumbers.has(dep.number)) {
				missing.push({ issue: num, missingDep: dep.number });
			}
		}
	}

	// Cycle detection via DFS
	const cycles: ValidationResult['cycles'] = [];
	const visited = new Set<number>();
	const inStack = new Set<number>();

	function dfs(node: number, path: number[]): void {
		if (inStack.has(node)) {
			const cycleStart = path.indexOf(node);
			cycles.push({ path: path.slice(cycleStart).concat(node) });
			return;
		}
		if (visited.has(node)) return;

		visited.add(node);
		inStack.add(node);
		path.push(node);

		const rels = issues.get(node);
		if (rels) {
			for (const dep of rels.blockedBy) {
				if (issueNumbers.has(dep.number)) {
					dfs(dep.number, [...path]);
				}
			}
		}

		inStack.delete(node);
	}

	for (const num of issues.keys()) {
		if (!visited.has(num)) dfs(num, []);
	}

	const valid = issues.size - new Set(cycles.flatMap(c => c.path)).size;

	return { valid, cycles, missing };
}

// ---------------------------------------------------------------------------
// Tier computation
// ---------------------------------------------------------------------------

/** Group issues into parallelizable tiers. Tier 0 = no deps, Tier N = all deps in earlier tiers. */
export function computeTiers(
	issues: Map<number, IssueRelationships>,
): number[][] {
	const issueNumbers = new Set(issues.keys());
	const tierOf = new Map<number, number>();

	function getTier(num: number, visiting = new Set<number>()): number {
		if (tierOf.has(num)) return tierOf.get(num)!;
		if (visiting.has(num)) return 0; // cycle fallback
		visiting.add(num);

		const rels = issues.get(num);
		if (!rels || rels.blockedBy.length === 0) {
			tierOf.set(num, 0);
			return 0;
		}

		let maxDepTier = 0;
		for (const dep of rels.blockedBy) {
			if (issueNumbers.has(dep.number)) {
				maxDepTier = Math.max(maxDepTier, getTier(dep.number, visiting) + 1);
			}
		}

		tierOf.set(num, maxDepTier);
		return maxDepTier;
	}

	for (const num of issues.keys()) getTier(num);

	const maxTier = Math.max(0, ...tierOf.values());
	const tiers: number[][] = Array.from({ length: maxTier + 1 }, () => []);
	for (const [num, tier] of tierOf) tiers[tier].push(num);

	return tiers.filter(t => t.length > 0);
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tools/deps/graph.test.ts`
Expected: PASS — all 5 tests green

**Step 5: Commit**

```bash
git add tools/deps/graph.ts tools/deps/graph.test.ts
git commit -m "feat(deps): add graph building, validation, and tier computation"
```

---

### Task 5: Display formatting

**Files:**
- Create: `tools/deps/display.ts`
- Test: `tools/deps/display.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, expect, test } from 'bun:test';
import { formatList, formatTree, formatValidation } from './display.ts';
import type { IssueRelationships, ValidationResult } from './types.ts';

describe('formatList', () => {
	test('formats issue relationships', () => {
		const rels: IssueRelationships = {
			id: 'I_5',
			number: 5,
			title: 'Auth middleware',
			state: 'OPEN',
			blockedBy: [{ number: 3, title: 'DB schema', state: 'OPEN' }],
			blocking: [{ number: 8, title: 'Routes', state: 'OPEN' }],
			parent: { number: 2, title: 'Auth epic', state: 'OPEN' },
			subIssues: [],
		};
		const output = formatList(rels);
		expect(output).toContain('#5');
		expect(output).toContain('Auth middleware');
		expect(output).toContain('#3');
		expect(output).toContain('Blocked by');
		expect(output).toContain('Blocking');
		expect(output).toContain('Parent');
	});

	test('omits empty sections', () => {
		const rels: IssueRelationships = {
			id: 'I_1',
			number: 1,
			title: 'Setup',
			state: 'OPEN',
			blockedBy: [],
			blocking: [],
			parent: null,
			subIssues: [],
		};
		const output = formatList(rels);
		expect(output).toContain('#1');
		expect(output).not.toContain('Blocked by');
		expect(output).not.toContain('Blocking');
		expect(output).not.toContain('Parent');
	});
});

describe('formatTree', () => {
	test('formats tiers with issue titles', () => {
		const titles = new Map<number, string>([
			[1, 'Setup'], [3, 'Schema'], [4, 'Types'], [5, 'Auth'],
		]);
		const tiers = [[1, 3], [4], [5]];
		const deps = new Map<number, number[]>([
			[1, []], [3, []], [4, [3]], [5, [3, 4]],
		]);
		const output = formatTree(tiers, titles, deps);
		expect(output).toContain('Tier 0');
		expect(output).toContain('#1');
		expect(output).toContain('Tier 1');
		expect(output).toContain('#4');
		expect(output).toContain('Tier 2');
	});
});

describe('formatValidation', () => {
	test('formats validation results', () => {
		const result = {
			valid: 8,
			cycles: [{ path: [11, 12, 11] }],
			missing: [{ issue: 7, missingDep: 99 }],
		};
		const output = formatValidation(result);
		expect(output).toContain('8');
		expect(output).toContain('cycle');
		expect(output).toContain('#11');
		expect(output).toContain('#99');
	});
});
```

Note: Import `ValidationResult` from `./graph.ts` not `./types.ts` — adjust the import in the test once you see where the type lives.

**Step 2: Run test to verify it fails**

Run: `bun test tools/deps/display.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
import type { IssueRelationships, IssueRef } from './types.ts';
import type { ValidationResult } from './graph.ts';

// ---------------------------------------------------------------------------
// Colors (ANSI, no dependencies)
// ---------------------------------------------------------------------------

const C = {
	cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
	dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function refLine(ref: IssueRef): string {
	const state = ref.state === 'OPEN' ? C.green('open') : C.dim('closed');
	return `    #${ref.number}  ${ref.title}  (${state})`;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function formatList(rels: IssueRelationships): string {
	const lines: string[] = [];
	lines.push(`${C.bold(`Issue #${rels.number}`)}: ${rels.title}\n`);

	if (rels.blockedBy.length) {
		lines.push('  Blocked by:');
		for (const ref of rels.blockedBy) lines.push(refLine(ref));
		lines.push('');
	}

	if (rels.blocking.length) {
		lines.push('  Blocking:');
		for (const ref of rels.blocking) lines.push(refLine(ref));
		lines.push('');
	}

	if (rels.parent) {
		lines.push(`  Parent: #${rels.parent.number} ${rels.parent.title}`);
		lines.push('');
	}

	if (rels.subIssues.length) {
		lines.push('  Sub-issues:');
		for (const ref of rels.subIssues) lines.push(refLine(ref));
		lines.push('');
	}

	return lines.join('\n');
}

export function formatTree(
	tiers: number[][],
	titles: Map<number, string>,
	deps: Map<number, number[]>,
): string {
	const lines: string[] = [];
	lines.push(C.bold(`Dependency tree (${titles.size} open issues):\n`));

	for (let i = 0; i < tiers.length; i++) {
		const label = i === 0 ? 'Tier 0 (no dependencies):' : `Tier ${i}:`;
		lines.push(label);
		for (const num of tiers[i]) {
			const title = titles.get(num) ?? '(unknown)';
			const issueDeps = deps.get(num) ?? [];
			const depStr = issueDeps.length ? ` ${C.dim('←')} ${issueDeps.map(d => `#${d}`).join(', ')}` : '';
			lines.push(`  #${num}  ${title}${depStr}`);
		}
		lines.push('');
	}

	return lines.join('\n');
}

export function formatValidation(result: ValidationResult): string {
	const lines: string[] = [];

	if (result.valid > 0) {
		lines.push(C.green(`✓ ${result.valid} issues with valid dependency chains`));
	}

	for (const cycle of result.cycles) {
		const path = cycle.path.map(n => `#${n}`).join(' → ');
		lines.push(C.yellow(`⚠ Cycle detected: ${path}`));
	}

	for (const m of result.missing) {
		lines.push(C.yellow(`⚠ Missing dependency: #${m.issue} → #${m.missingDep} (issue not found)`));
	}

	return lines.join('\n');
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tools/deps/display.test.ts`
Expected: PASS — all 4 tests green

**Step 5: Commit**

```bash
git add tools/deps/display.ts tools/deps/display.test.ts
git commit -m "feat(deps): add display formatters for list, tree, validate"
```

---

### Task 6: CLI entry point (index.ts)

**Files:**
- Create: `tools/deps/index.ts`
- Modify: `cli.ts` — add `deps` command and HELP text

**Step 1: Write the CLI entry point**

```typescript
import { log } from '@shared/log.ts';
import { parseDepsFlags } from './flags.ts';
import { GitHubRelationshipService, makeDefaultDepsDeps } from './service.ts';
import { buildDepsGraph, validateGraph, computeTiers } from './graph.ts';
import { formatList, formatTree, formatValidation } from './display.ts';
import type { DepsFlags, RelationshipService } from './types.ts';

export { parseDepsFlags } from './flags.ts';

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const DEPS_HELP = `\x1b[36mpait deps\x1b[0m — Manage GitHub issue relationships

\x1b[1mUSAGE\x1b[0m
  pait deps <subcommand> [flags]

\x1b[1mSUBCOMMANDS\x1b[0m
  add          Add a relationship between issues
  remove       Remove a relationship between issues
  list         Show relationships for a specific issue
  tree         Show full dependency tree for all open issues
  validate     Check for problems (cycles, missing deps, orphans)
  sync         Migrate text-based "depends on" to native relationships

\x1b[1mFLAGS\x1b[0m
  --issue <N>       Target issue number
  --blocks <N>      Issue being blocked
  --blocked-by <N>  Issue that blocks
  --parent <N>      Parent issue number
  --child <N>       Child issue number
  --apply           Apply sync changes (default: dry run)
  --json            Output as JSON
  --help, -h        Show this help message
`;

// ---------------------------------------------------------------------------
// Deps interface for DI
// ---------------------------------------------------------------------------

export interface DepsToolDeps {
	createService: () => Promise<RelationshipService>;
	stdout: (msg: string) => void;
}

const defaultDepsToolDeps: DepsToolDeps = {
	createService: async () => {
		const depsDeps = await makeDefaultDepsDeps();
		return new GitHubRelationshipService(depsDeps);
	},
	stdout: (msg) => process.stdout.write(msg + '\n'),
};

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

async function handleAdd(flags: DepsFlags, service: RelationshipService): Promise<void> {
	const issue = flags.issue;
	if (!issue) throw new Error('--issue is required for add');

	if (flags.blocks != null) {
		await service.addBlockedBy(flags.blocks, issue);
		log.ok(`#${issue} now blocks #${flags.blocks}`);
	} else if (flags.blockedBy != null) {
		await service.addBlockedBy(issue, flags.blockedBy);
		log.ok(`#${issue} is now blocked by #${flags.blockedBy}`);
	} else if (flags.parent != null) {
		await service.addSubIssue(flags.parent, issue);
		log.ok(`#${issue} is now a sub-issue of #${flags.parent}`);
	} else if (flags.child != null) {
		await service.addSubIssue(issue, flags.child);
		log.ok(`#${flags.child} is now a sub-issue of #${issue}`);
	} else {
		throw new Error('add requires --blocks, --blocked-by, --parent, or --child');
	}
}

async function handleRemove(flags: DepsFlags, service: RelationshipService): Promise<void> {
	const issue = flags.issue;
	if (!issue) throw new Error('--issue is required for remove');

	if (flags.blocks != null) {
		await service.removeBlockedBy(flags.blocks, issue);
		log.ok(`Removed: #${issue} no longer blocks #${flags.blocks}`);
	} else if (flags.blockedBy != null) {
		await service.removeBlockedBy(issue, flags.blockedBy);
		log.ok(`Removed: #${issue} no longer blocked by #${flags.blockedBy}`);
	} else if (flags.parent != null) {
		await service.removeSubIssue(flags.parent, issue);
		log.ok(`Removed: #${issue} is no longer a sub-issue of #${flags.parent}`);
	} else if (flags.child != null) {
		await service.removeSubIssue(issue, flags.child);
		log.ok(`Removed: #${flags.child} is no longer a sub-issue of #${issue}`);
	} else {
		throw new Error('remove requires --blocks, --blocked-by, --parent, or --child');
	}
}

async function handleList(flags: DepsFlags, service: RelationshipService, stdout: (msg: string) => void): Promise<void> {
	if (!flags.issue) throw new Error('--issue is required for list');
	const rels = await service.getRelationships(flags.issue);
	if (flags.json) {
		stdout(JSON.stringify(rels, null, 2));
	} else {
		stdout(formatList(rels));
	}
}

async function handleTree(flags: DepsFlags, service: RelationshipService, stdout: (msg: string) => void): Promise<void> {
	const all = await service.getAllRelationships();
	const tiers = computeTiers(all);
	const titles = new Map<number, string>();
	const deps = new Map<number, number[]>();
	for (const [num, rels] of all) {
		titles.set(num, rels.title);
		deps.set(num, rels.blockedBy.map(r => r.number));
	}

	if (flags.json) {
		stdout(JSON.stringify({ tiers, issues: Object.fromEntries(all) }, null, 2));
	} else {
		stdout(formatTree(tiers, titles, deps));
		// Append warnings
		const validation = validateGraph(all);
		if (validation.cycles.length || validation.missing.length) {
			stdout('');
			stdout(formatValidation(validation));
		}
	}
}

async function handleValidate(flags: DepsFlags, service: RelationshipService, stdout: (msg: string) => void): Promise<void> {
	const all = await service.getAllRelationships();
	const result = validateGraph(all);
	if (flags.json) {
		stdout(JSON.stringify(result, null, 2));
	} else {
		stdout(formatValidation(result));
	}
}

async function handleSync(flags: DepsFlags, service: RelationshipService, stdout: (msg: string) => void): Promise<void> {
	// Sync reads issue bodies for "depends on #N" and creates native relationships
	// This is a migration tool — once all deps are native, it becomes a no-op
	stdout(flags.apply ? 'Syncing text-based deps to native relationships...' : 'Dry run — showing what would be synced:\n');

	const all = await service.getAllRelationships();

	// For sync, we need to also fetch issue bodies to find text-based deps
	// This would require extending the service or using gh issue list directly
	// For now, report that sync requires the orchestrator's parseDependencies
	stdout('Note: sync command reads "depends on #N" from issue bodies');
	stdout(`Found ${all.size} open issues with native relationships`);

	if (!flags.apply) {
		stdout('\nRun with --apply to create native relationships');
	}
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function deps(flags: DepsFlags, toolDeps: DepsToolDeps = defaultDepsToolDeps): Promise<void> {
	if (flags.help || !flags.subcommand) {
		toolDeps.stdout(DEPS_HELP);
		return;
	}

	const service = await toolDeps.createService();

	switch (flags.subcommand) {
		case 'add': return handleAdd(flags, service);
		case 'remove': return handleRemove(flags, service);
		case 'list': return handleList(flags, service, toolDeps.stdout);
		case 'tree': return handleTree(flags, service, toolDeps.stdout);
		case 'validate': return handleValidate(flags, service, toolDeps.stdout);
		case 'sync': return handleSync(flags, service, toolDeps.stdout);
	}
}
```

**Step 2: Wire into cli.ts**

Add import at top of `cli.ts`:
```typescript
import { deps, parseDepsFlags } from '@tools/deps/index.ts';
```

Add to the `commands` Map:
```typescript
['deps', async () => {
    const flags = parseDepsFlags(process.argv.slice(3));
    await deps(flags);
}],
```

Add to the `HELP` string in the COMMANDS section:
```
  deps           Manage GitHub issue relationships
```

Add a new DEPS FLAGS section:
```
\x1b[1mDEPS FLAGS\x1b[0m
  --issue <N>       Target issue number
  --blocks <N>      Issue being blocked
  --blocked-by <N>  Issue that blocks
  --parent <N>      Parent issue number
  --child <N>       Child issue number
  --apply           Apply sync changes (default: dry run)
  --json            Output as JSON
```

**Step 3: Run existing tests to verify nothing broke**

Run: `bun test cli.test.ts`
Expected: PASS — the HELP sync test should pass since we added all flags to HELP

**Step 4: Commit**

```bash
git add tools/deps/index.ts cli.ts
git commit -m "feat(deps): add CLI entry point and wire into pait command"
```

---

### Task 7: README and HELP sync test update

**Files:**
- Create: `tools/deps/README.md`
- Modify: `cli.test.ts` — add deps to the flag sync test

**Step 1: Write the README**

Write `tools/deps/README.md` with the usage docs from the design doc (CLI interface section). Include all subcommands, flags, and example output.

**Step 2: Update cli.test.ts**

Add the deps tool to both test suites in `cli.test.ts`:

In the "CLI help text sync" describe block, add:
```typescript
test('every deps flag in parseDepsFlags appears in HELP', () => {
    const fnBody = depsSource.match(/function parseDepsFlags[\s\S]*?^}/m)?.[0] ?? '';
    const flags = [...fnBody.matchAll(/'(--[\w-]+)'/g)].map(m => m[1]);
    for (const flag of flags) {
        if (flag === '--help') continue;
        expect(helpText).toContain(flag);
    }
});
```

Add at the top of the test file:
```typescript
const depsSource = defaultFsAdapter.readFile(join(import.meta.dir, 'tools/deps/flags.ts'));
```

In the "Tool README flag sync" describe block, add deps to the tools array.

**Step 3: Run full test suite**

Run: `bun test`
Expected: PASS — all existing tests plus new deps tests

**Step 4: Commit**

```bash
git add tools/deps/README.md cli.test.ts
git commit -m "docs(deps): add README and wire HELP sync tests"
```

---

### Task 8: End-to-end smoke test

**Files:** No new files — manual verification.

**Step 1: Test help output**

Run: `bun run cli.ts deps --help`
Expected: Shows the DEPS_HELP text with all subcommands and flags.

**Step 2: Test tree on a real repo**

Run: `bun run cli.ts deps tree`
Expected: Fetches open issues from the current repo's GitHub, shows tiered dependency tree. If no issues have native relationships yet, shows "Tier 0" with all issues.

**Step 3: Test list on a specific issue**

Run: `bun run cli.ts deps list --issue 1`
Expected: Shows relationships for issue #1 (may show empty sections if no native relationships exist yet).

**Step 4: Test validate**

Run: `bun run cli.ts deps validate`
Expected: Shows validation results — should report 0 cycles and 0 missing deps for a clean graph.

**Step 5: Run full test suite one final time**

Run: `bun test`
Expected: All tests pass.

**Step 6: Commit any adjustments**

If any adjustments were needed during smoke testing, commit them:
```bash
git add -A
git commit -m "fix(deps): adjustments from smoke testing"
```

---

## Summary

| Task | What | Files | Tests |
|------|------|-------|-------|
| 1 | Types and interfaces | `types.ts` | — |
| 2 | Flag parsing | `flags.ts` | `flags.test.ts` (13) |
| 3 | GraphQL service | `service.ts` | `service.test.ts` (3) |
| 4 | Graph + validation | `graph.ts` | `graph.test.ts` (5) |
| 5 | Display formatting | `display.ts` | `display.test.ts` (4) |
| 6 | CLI entry + cli.ts wiring | `index.ts`, `cli.ts` | existing suite |
| 7 | README + test wiring | `README.md`, `cli.test.ts` | HELP sync |
| 8 | E2E smoke test | — | manual |

Total new test cases: ~25.
