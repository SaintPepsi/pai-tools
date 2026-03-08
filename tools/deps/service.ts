/**
 * GitHub GraphQL service for issue dependency relationship management.
 */

import type { IssueRelationships, RelationshipService } from 'tools/deps/types.ts';

// ─── GraphQL Queries & Mutations ─────────────────────────────────────────────

const RESOLVE_ISSUE_ID = `
  query ResolveIssueId($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        id
      }
    }
  }
`;

const GET_ISSUE_RELATIONSHIPS = `
  query GetIssueRelationships($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        databaseId
        number
        title
        state
        parent { number }
        subIssues(first: 100) {
          nodes { number }
        }
        issueRelationships(first: 100) {
          nodes {
            type
            subject { ... on Issue { number } }
            object { ... on Issue { number } }
          }
        }
      }
    }
  }
`;

const GET_ALL_OPEN_ISSUES = `
  query GetAllOpenIssues($owner: String!, $repo: String!, $after: String) {
    repository(owner: $owner, name: $repo) {
      issues(first: 100, states: [OPEN], after: $after) {
        nodes {
          databaseId
          number
          title
          state
          parent { number }
          subIssues(first: 100) {
            nodes { number }
          }
          issueRelationships(first: 100) {
            nodes {
              type
              subject { ... on Issue { number } }
              object { ... on Issue { number } }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const CREATE_ISSUE_RELATIONSHIP = `
  mutation CreateIssueRelationship($subjectId: ID!, $objectId: ID!, $type: IssueRelationshipType!) {
    createIssueRelationship(input: { subjectId: $subjectId, objectId: $objectId, type: $type }) {
      relationship { type }
    }
  }
`;

const DELETE_ISSUE_RELATIONSHIP = `
  mutation DeleteIssueRelationship($subjectId: ID!, $objectId: ID!, $type: IssueRelationshipType!) {
    deleteIssueRelationship(input: { subjectId: $subjectId, objectId: $objectId, type: $type }) {
      clientMutationId
    }
  }
`;

const ADD_SUB_ISSUE = `
  mutation AddSubIssue($issueId: ID!, $subIssueId: ID!) {
    addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) {
      issue { number }
      subIssue { number }
    }
  }
`;

const REMOVE_SUB_ISSUE = `
  mutation RemoveSubIssue($issueId: ID!, $subIssueId: ID!) {
    removeSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) {
      issue { number }
      subIssue { number }
    }
  }
`;

// ─── Internal GraphQL Types ───────────────────────────────────────────────────

interface RelationshipNode {
	type: string;
	subject: { number: number };
	object: { number: number };
}

interface IssueNode {
	databaseId: number;
	number: number;
	title: string;
	state: string;
	parent: { number: number } | null;
	subIssues: { nodes: Array<{ number: number }> };
	issueRelationships: { nodes: RelationshipNode[] };
}

// ─── Deps Interface ───────────────────────────────────────────────────────────

export interface GitHubServiceDeps {
	/** Execute a GitHub GraphQL query/mutation and return parsed JSON. */
	graphql: (query: string, variables: Record<string, unknown>) => Promise<unknown>;
	/** Return the owner login and repo name for the current working directory. */
	getRepoInfo: () => Promise<{ owner: string; name: string }>;
	stderr: (msg: string) => void;
}

// ─── Default Dep Implementations ─────────────────────────────────────────────

async function defaultGraphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
	const payload = JSON.stringify({ query, variables });
	const proc = Bun.spawn(['gh', 'api', 'graphql', '--input', '-'], {
		stdin: new Blob([payload]),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [output, errOutput] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`gh api graphql failed: ${errOutput.trim()}`);
	}
	return JSON.parse(output);
}

async function defaultGetRepoInfo(): Promise<{ owner: string; name: string }> {
	const proc = Bun.spawn(['gh', 'repo', 'view', '--json', 'owner,name'], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const output = await new Response(proc.stdout).text();
	await proc.exited;
	const raw = JSON.parse(output) as { owner: { login: string }; name: string };
	return { owner: raw.owner.login, name: raw.name };
}

const defaultDeps: GitHubServiceDeps = {
	graphql: defaultGraphql,
	getRepoInfo: defaultGetRepoInfo,
	stderr: (msg) => process.stderr.write(msg + '\n'),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseIssueRelationships(node: IssueNode): IssueRelationships {
	const blockedBy: number[] = [];
	const blocking: number[] = [];

	for (const rel of node.issueRelationships.nodes) {
		if (rel.type === 'BLOCKED_BY' && rel.subject.number === node.number) {
			blockedBy.push(rel.object.number);
		} else if (rel.type === 'BLOCKS' && rel.subject.number === node.number) {
			blocking.push(rel.object.number);
		}
	}

	return {
		id: node.databaseId,
		number: node.number,
		title: node.title,
		state: node.state,
		blockedBy,
		blocking,
		parent: node.parent?.number ?? null,
		subIssues: node.subIssues.nodes.map(n => n.number),
	};
}

// ─── Service Implementation ───────────────────────────────────────────────────

export class GitHubRelationshipService implements RelationshipService {
	private readonly deps: GitHubServiceDeps;
	private repoCache: { owner: string; name: string } | null = null;

	constructor(deps: GitHubServiceDeps = defaultDeps) {
		this.deps = deps;
	}

	private async repo(): Promise<{ owner: string; name: string }> {
		if (!this.repoCache) {
			this.repoCache = await this.deps.getRepoInfo();
		}
		return this.repoCache;
	}

	/** Convert an issue number to a GitHub node ID. */
	async resolveIssueId(issueNumber: number): Promise<string> {
		const { owner, name } = await this.repo();
		const result = await this.deps.graphql(RESOLVE_ISSUE_ID, {
			owner,
			repo: name,
			number: issueNumber,
		}) as { data: { repository: { issue: { id: string } } } };
		return result.data.repository.issue.id;
	}

	async getRelationships(issueNumber: number): Promise<IssueRelationships> {
		const { owner, name } = await this.repo();
		const result = await this.deps.graphql(GET_ISSUE_RELATIONSHIPS, {
			owner,
			repo: name,
			number: issueNumber,
		}) as { data: { repository: { issue: IssueNode } } };
		return parseIssueRelationships(result.data.repository.issue);
	}

	/** Fetch relationships for all open issues, paginating as needed. */
	async getAllRelationships(): Promise<IssueRelationships[]> {
		const { owner, name } = await this.repo();
		const all: IssueRelationships[] = [];
		let after: string | null = null;

		while (true) {
			const result = await this.deps.graphql(GET_ALL_OPEN_ISSUES, {
				owner,
				repo: name,
				after,
			}) as {
				data: {
					repository: {
						issues: {
							nodes: IssueNode[];
							pageInfo: { hasNextPage: boolean; endCursor: string };
						};
					};
				};
			};

			const { nodes, pageInfo } = result.data.repository.issues;
			for (const node of nodes) {
				all.push(parseIssueRelationships(node));
			}

			if (!pageInfo.hasNextPage) break;
			after = pageInfo.endCursor;
		}

		return all;
	}

	async addBlockedBy(issueNumber: number, blockerNumber: number): Promise<void> {
		const [issueId, blockerId] = await Promise.all([
			this.resolveIssueId(issueNumber),
			this.resolveIssueId(blockerNumber),
		]);
		await this.deps.graphql(CREATE_ISSUE_RELATIONSHIP, {
			subjectId: issueId,
			objectId: blockerId,
			type: 'BLOCKED_BY',
		});
	}

	async removeBlockedBy(issueNumber: number, blockerNumber: number): Promise<void> {
		const [issueId, blockerId] = await Promise.all([
			this.resolveIssueId(issueNumber),
			this.resolveIssueId(blockerNumber),
		]);
		await this.deps.graphql(DELETE_ISSUE_RELATIONSHIP, {
			subjectId: issueId,
			objectId: blockerId,
			type: 'BLOCKED_BY',
		});
	}

	async setParent(issueNumber: number, parentNumber: number | null): Promise<void> {
		if (parentNumber !== null) {
			await this.addSubIssue(parentNumber, issueNumber);
		} else {
			const rel = await this.getRelationships(issueNumber);
			if (rel.parent !== null) {
				await this.removeSubIssue(rel.parent, issueNumber);
			}
		}
	}

	async addSubIssue(issueNumber: number, subIssueNumber: number): Promise<void> {
		const [issueId, subIssueId] = await Promise.all([
			this.resolveIssueId(issueNumber),
			this.resolveIssueId(subIssueNumber),
		]);
		await this.deps.graphql(ADD_SUB_ISSUE, { issueId, subIssueId });
	}

	async removeSubIssue(issueNumber: number, subIssueNumber: number): Promise<void> {
		const [issueId, subIssueId] = await Promise.all([
			this.resolveIssueId(issueNumber),
			this.resolveIssueId(subIssueNumber),
		]);
		await this.deps.graphql(REMOVE_SUB_ISSUE, { issueId, subIssueId });
	}
}
