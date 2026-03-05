import { describe, test, expect } from 'bun:test';
import { GitHubRelationshipService } from 'tools/deps/service.ts';
import type { GitHubServiceDeps } from 'tools/deps/service.ts';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const REPO = { owner: 'acme', name: 'widgets' };

function makeIssueNode(overrides: Partial<{
	databaseId: number;
	number: number;
	title: string;
	state: string;
	parent: { number: number } | null;
	subIssues: { nodes: Array<{ number: number }> };
	issueRelationships: { nodes: Array<{ type: string; subject: { number: number }; object: { number: number } }> };
}> = {}) {
	return {
		databaseId: 1,
		number: 1,
		title: 'Test Issue',
		state: 'OPEN',
		parent: null,
		subIssues: { nodes: [] },
		issueRelationships: { nodes: [] },
		...overrides,
	};
}

function makeDeps(graphqlImpl: (query: string, variables: Record<string, unknown>) => Promise<unknown>): GitHubServiceDeps {
	return {
		graphql: graphqlImpl,
		getRepoInfo: async () => REPO,
		stderr: () => {},
	};
}

// ─── resolveIssueId ──────────────────────────────────────────────────────────

describe('resolveIssueId', () => {
	test('returns node id for issue number', async () => {
		const deps = makeDeps(async () => ({
			data: { repository: { issue: { id: 'I_abc123' } } },
		}));
		const svc = new GitHubRelationshipService(deps);
		expect(await svc.resolveIssueId(42)).toBe('I_abc123');
	});

	test('passes owner, repo, and number as variables', async () => {
		let capturedVars: Record<string, unknown> = {};
		const deps = makeDeps(async (_, vars) => {
			capturedVars = vars;
			return { data: { repository: { issue: { id: 'I_xyz' } } } };
		});
		const svc = new GitHubRelationshipService(deps);
		await svc.resolveIssueId(7);
		expect(capturedVars).toEqual({ owner: 'acme', repo: 'widgets', number: 7 });
	});
});

// ─── getRelationships ────────────────────────────────────────────────────────

describe('getRelationships', () => {
	test('returns basic issue data', async () => {
		const node = makeIssueNode({ databaseId: 10, number: 3, title: 'Fix bug', state: 'OPEN' });
		const deps = makeDeps(async () => ({ data: { repository: { issue: node } } }));
		const svc = new GitHubRelationshipService(deps);
		const rel = await svc.getRelationships(3);
		expect(rel.id).toBe(10);
		expect(rel.number).toBe(3);
		expect(rel.title).toBe('Fix bug');
		expect(rel.state).toBe('OPEN');
	});

	test('returns empty arrays when no relationships', async () => {
		const node = makeIssueNode({ number: 1 });
		const deps = makeDeps(async () => ({ data: { repository: { issue: node } } }));
		const svc = new GitHubRelationshipService(deps);
		const rel = await svc.getRelationships(1);
		expect(rel.blockedBy).toEqual([]);
		expect(rel.blocking).toEqual([]);
		expect(rel.subIssues).toEqual([]);
		expect(rel.parent).toBeNull();
	});

	test('parses parent issue number', async () => {
		const node = makeIssueNode({ number: 5, parent: { number: 2 } });
		const deps = makeDeps(async () => ({ data: { repository: { issue: node } } }));
		const svc = new GitHubRelationshipService(deps);
		const rel = await svc.getRelationships(5);
		expect(rel.parent).toBe(2);
	});

	test('parses sub-issue numbers', async () => {
		const node = makeIssueNode({ number: 1, subIssues: { nodes: [{ number: 3 }, { number: 4 }] } });
		const deps = makeDeps(async () => ({ data: { repository: { issue: node } } }));
		const svc = new GitHubRelationshipService(deps);
		const rel = await svc.getRelationships(1);
		expect(rel.subIssues).toEqual([3, 4]);
	});

	test('parses BLOCKED_BY relationships into blockedBy', async () => {
		const node = makeIssueNode({
			number: 5,
			issueRelationships: {
				nodes: [{ type: 'BLOCKED_BY', subject: { number: 5 }, object: { number: 2 } }],
			},
		});
		const deps = makeDeps(async () => ({ data: { repository: { issue: node } } }));
		const svc = new GitHubRelationshipService(deps);
		const rel = await svc.getRelationships(5);
		expect(rel.blockedBy).toEqual([2]);
		expect(rel.blocking).toEqual([]);
	});

	test('parses BLOCKS relationships into blocking', async () => {
		const node = makeIssueNode({
			number: 5,
			issueRelationships: {
				nodes: [{ type: 'BLOCKS', subject: { number: 5 }, object: { number: 8 } }],
			},
		});
		const deps = makeDeps(async () => ({ data: { repository: { issue: node } } }));
		const svc = new GitHubRelationshipService(deps);
		const rel = await svc.getRelationships(5);
		expect(rel.blocking).toEqual([8]);
		expect(rel.blockedBy).toEqual([]);
	});

	test('ignores relationships where this issue is not the subject', async () => {
		const node = makeIssueNode({
			number: 5,
			issueRelationships: {
				nodes: [{ type: 'BLOCKED_BY', subject: { number: 99 }, object: { number: 5 } }],
			},
		});
		const deps = makeDeps(async () => ({ data: { repository: { issue: node } } }));
		const svc = new GitHubRelationshipService(deps);
		const rel = await svc.getRelationships(5);
		expect(rel.blockedBy).toEqual([]);
		expect(rel.blocking).toEqual([]);
	});
});

// ─── getAllRelationships ──────────────────────────────────────────────────────

describe('getAllRelationships', () => {
	test('returns all issues from a single page', async () => {
		const nodes = [
			makeIssueNode({ number: 1, databaseId: 1 }),
			makeIssueNode({ number: 2, databaseId: 2 }),
		];
		const deps = makeDeps(async () => ({
			data: {
				repository: {
					issues: {
						nodes,
						pageInfo: { hasNextPage: false, endCursor: 'cursor1' },
					},
				},
			},
		}));
		const svc = new GitHubRelationshipService(deps);
		const all = await svc.getAllRelationships();
		expect(all).toHaveLength(2);
		expect(all[0].number).toBe(1);
		expect(all[1].number).toBe(2);
	});

	test('paginates across multiple pages', async () => {
		let callCount = 0;
		const deps = makeDeps(async (_, vars) => {
			callCount++;
			if (vars['after'] === null) {
				return {
					data: {
						repository: {
							issues: {
								nodes: [makeIssueNode({ number: 1, databaseId: 1 })],
								pageInfo: { hasNextPage: true, endCursor: 'cursor1' },
							},
						},
					},
				};
			}
			return {
				data: {
					repository: {
						issues: {
							nodes: [makeIssueNode({ number: 2, databaseId: 2 })],
							pageInfo: { hasNextPage: false, endCursor: 'cursor2' },
						},
					},
				},
			};
		});
		const svc = new GitHubRelationshipService(deps);
		const all = await svc.getAllRelationships();
		expect(all).toHaveLength(2);
		expect(callCount).toBe(2);
	});

	test('passes cursor from first page to second page', async () => {
		const cursors: Array<string | null> = [];
		const deps = makeDeps(async (_, vars) => {
			cursors.push(vars['after'] as string | null);
			const hasNextPage = cursors.length === 1;
			return {
				data: {
					repository: {
						issues: {
							nodes: [makeIssueNode({ number: cursors.length })],
							pageInfo: { hasNextPage, endCursor: 'page2cursor' },
						},
					},
				},
			};
		});
		const svc = new GitHubRelationshipService(deps);
		await svc.getAllRelationships();
		expect(cursors[0]).toBeNull();
		expect(cursors[1]).toBe('page2cursor');
	});
});

// ─── addBlockedBy ────────────────────────────────────────────────────────────

describe('addBlockedBy', () => {
	test('resolves IDs and creates BLOCKED_BY relationship', async () => {
		const calls: Array<{ query: string; vars: Record<string, unknown> }> = [];
		const deps = makeDeps(async (query, vars) => {
			calls.push({ query, vars });
			if (query.includes('ResolveIssueId') && vars['number'] === 5) {
				return { data: { repository: { issue: { id: 'I_issue5' } } } };
			}
			if (query.includes('ResolveIssueId') && vars['number'] === 2) {
				return { data: { repository: { issue: { id: 'I_issue2' } } } };
			}
			return { data: {} };
		});
		const svc = new GitHubRelationshipService(deps);
		await svc.addBlockedBy(5, 2);
		const mutationCall = calls.find(c => c.query.includes('CreateIssueRelationship'));
		expect(mutationCall).toBeDefined();
		expect(mutationCall!.vars).toMatchObject({
			subjectId: 'I_issue5',
			objectId: 'I_issue2',
			type: 'BLOCKED_BY',
		});
	});
});

// ─── removeBlockedBy ─────────────────────────────────────────────────────────

describe('removeBlockedBy', () => {
	test('resolves IDs and deletes BLOCKED_BY relationship', async () => {
		const calls: Array<{ query: string; vars: Record<string, unknown> }> = [];
		const deps = makeDeps(async (query, vars) => {
			calls.push({ query, vars });
			if (query.includes('ResolveIssueId') && vars['number'] === 5) {
				return { data: { repository: { issue: { id: 'I_issue5' } } } };
			}
			if (query.includes('ResolveIssueId') && vars['number'] === 2) {
				return { data: { repository: { issue: { id: 'I_issue2' } } } };
			}
			return { data: {} };
		});
		const svc = new GitHubRelationshipService(deps);
		await svc.removeBlockedBy(5, 2);
		const mutationCall = calls.find(c => c.query.includes('DeleteIssueRelationship'));
		expect(mutationCall).toBeDefined();
		expect(mutationCall!.vars).toMatchObject({
			subjectId: 'I_issue5',
			objectId: 'I_issue2',
			type: 'BLOCKED_BY',
		});
	});
});

// ─── addSubIssue ─────────────────────────────────────────────────────────────

describe('addSubIssue', () => {
	test('resolves IDs and adds sub-issue', async () => {
		const calls: Array<{ query: string; vars: Record<string, unknown> }> = [];
		const deps = makeDeps(async (query, vars) => {
			calls.push({ query, vars });
			if (query.includes('ResolveIssueId') && vars['number'] === 1) {
				return { data: { repository: { issue: { id: 'I_parent' } } } };
			}
			if (query.includes('ResolveIssueId') && vars['number'] === 3) {
				return { data: { repository: { issue: { id: 'I_child' } } } };
			}
			return { data: {} };
		});
		const svc = new GitHubRelationshipService(deps);
		await svc.addSubIssue(1, 3);
		const mutationCall = calls.find(c => c.query.includes('AddSubIssue'));
		expect(mutationCall).toBeDefined();
		expect(mutationCall!.vars).toEqual({ issueId: 'I_parent', subIssueId: 'I_child' });
	});
});

// ─── removeSubIssue ──────────────────────────────────────────────────────────

describe('removeSubIssue', () => {
	test('resolves IDs and removes sub-issue', async () => {
		const calls: Array<{ query: string; vars: Record<string, unknown> }> = [];
		const deps = makeDeps(async (query, vars) => {
			calls.push({ query, vars });
			if (query.includes('ResolveIssueId') && vars['number'] === 1) {
				return { data: { repository: { issue: { id: 'I_parent' } } } };
			}
			if (query.includes('ResolveIssueId') && vars['number'] === 3) {
				return { data: { repository: { issue: { id: 'I_child' } } } };
			}
			return { data: {} };
		});
		const svc = new GitHubRelationshipService(deps);
		await svc.removeSubIssue(1, 3);
		const mutationCall = calls.find(c => c.query.includes('RemoveSubIssue'));
		expect(mutationCall).toBeDefined();
		expect(mutationCall!.vars).toEqual({ issueId: 'I_parent', subIssueId: 'I_child' });
	});
});

// ─── setParent ───────────────────────────────────────────────────────────────

describe('setParent', () => {
	test('delegates to addSubIssue when parent is non-null', async () => {
		const calls: Array<{ query: string; vars: Record<string, unknown> }> = [];
		const deps = makeDeps(async (query, vars) => {
			calls.push({ query, vars });
			if (query.includes('ResolveIssueId') && vars['number'] === 2) {
				return { data: { repository: { issue: { id: 'I_parent' } } } };
			}
			if (query.includes('ResolveIssueId') && vars['number'] === 5) {
				return { data: { repository: { issue: { id: 'I_child' } } } };
			}
			return { data: {} };
		});
		const svc = new GitHubRelationshipService(deps);
		await svc.setParent(5, 2);
		const mutationCall = calls.find(c => c.query.includes('AddSubIssue'));
		expect(mutationCall).toBeDefined();
		expect(mutationCall!.vars).toEqual({ issueId: 'I_parent', subIssueId: 'I_child' });
	});

	test('removes from current parent when parent is null', async () => {
		const calls: Array<{ query: string; vars: Record<string, unknown> }> = [];
		const deps = makeDeps(async (query, vars) => {
			calls.push({ query, vars });
			if (query.includes('GetIssueRelationships')) {
				return {
					data: {
						repository: {
							issue: makeIssueNode({ number: 5, parent: { number: 2 } }),
						},
					},
				};
			}
			if (query.includes('ResolveIssueId') && vars['number'] === 2) {
				return { data: { repository: { issue: { id: 'I_parent' } } } };
			}
			if (query.includes('ResolveIssueId') && vars['number'] === 5) {
				return { data: { repository: { issue: { id: 'I_child' } } } };
			}
			return { data: {} };
		});
		const svc = new GitHubRelationshipService(deps);
		await svc.setParent(5, null);
		const mutationCall = calls.find(c => c.query.includes('RemoveSubIssue'));
		expect(mutationCall).toBeDefined();
		expect(mutationCall!.vars).toEqual({ issueId: 'I_parent', subIssueId: 'I_child' });
	});

	test('does nothing when removing parent from parentless issue', async () => {
		const calls: Array<{ query: string; vars: Record<string, unknown> }> = [];
		const deps = makeDeps(async (query, vars) => {
			calls.push({ query, vars });
			if (query.includes('GetIssueRelationships')) {
				return {
					data: {
						repository: {
							issue: makeIssueNode({ number: 5, parent: null }),
						},
					},
				};
			}
			return { data: {} };
		});
		const svc = new GitHubRelationshipService(deps);
		await svc.setParent(5, null);
		const mutationCall = calls.find(c =>
			c.query.includes('RemoveSubIssue') || c.query.includes('AddSubIssue')
		);
		expect(mutationCall).toBeUndefined();
	});
});

// ─── repo caching ────────────────────────────────────────────────────────────

describe('repo info caching', () => {
	test('getRepoInfo is called only once across multiple operations', async () => {
		let repoInfoCalls = 0;
		const deps: GitHubServiceDeps = {
			graphql: async (query, vars) => {
				if (query.includes('ResolveIssueId') && vars['number'] === 1) {
					return { data: { repository: { issue: { id: 'I_1' } } } };
				}
				if (query.includes('ResolveIssueId') && vars['number'] === 2) {
					return { data: { repository: { issue: { id: 'I_2' } } } };
				}
				return { data: {} };
			},
			getRepoInfo: async () => {
				repoInfoCalls++;
				return REPO;
			},
			stderr: () => {},
		};
		const svc = new GitHubRelationshipService(deps);
		await svc.resolveIssueId(1);
		await svc.resolveIssueId(2);
		expect(repoInfoCalls).toBe(1);
	});
});
