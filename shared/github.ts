/**
 * Shared GitHub helpers — all gh CLI operations consolidated here.
 *
 * Import from this module, not from tool-specific files, when working
 * with GitHub issues or PRs via the gh CLI.
 */

import { $ } from 'bun';
import { existsSync, readFileSync } from 'node:fs';
import { log } from './log.ts';
import { getStateFilePath } from './config.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubIssue {
	number: number;
	title: string;
	body: string;
	state: string;
	labels: { name: string }[];
}

export type MergeStrategy = 'squash' | 'merge' | 'rebase';

export interface MergeOrder {
	issueNumber: number;
	prNumber: number;
	branch: string;
	baseBranch: string;
}

// ---------------------------------------------------------------------------
// Issue operations
// ---------------------------------------------------------------------------

export async function fetchOpenIssues(allowedAuthors?: string[]): Promise<GitHubIssue[]> {
	const authors = allowedAuthors?.length
		? allowedAuthors
		: [(await $`gh api user --jq .login`.text()).trim()];

	log.info(`Filtering issues by author(s): ${authors.join(', ')}`);

	const seen = new Set<number>();
	const issues: GitHubIssue[] = [];

	for (const author of authors) {
		const result =
			await $`gh issue list --state open --limit 200 --author ${author} --json number,title,body,state,labels`.text();
		for (const issue of JSON.parse(result) as GitHubIssue[]) {
			if (!seen.has(issue.number)) {
				seen.add(issue.number);
				issues.push(issue);
			}
		}
	}

	return issues;
}

export async function createSubIssues(
	parentIssue: GitHubIssue,
	splits: { title: string; body: string }[],
	parentDeps: number[]
): Promise<number[]> {
	const createdNumbers: number[] = [];
	let previousSubIssue: number | null = null;

	for (const split of splits) {
		const deps: number[] =
			previousSubIssue !== null
				? [previousSubIssue]
				: parentDeps.filter((d: number) => d !== parentIssue.number);

		const depsLine: string =
			deps.length > 0 ? `> **Depends on:** ${deps.map((d: number) => `#${d}`).join(', ')}\n\n` : '';

		const issueBody: string = `${depsLine}> **Part of** #${parentIssue.number}\n\n${split.body}`;
		const title: string = split.title;

		const result: string = (
			await $`gh issue create --title ${title} --body ${issueBody}`.text()
		).trim();
		const match: RegExpMatchArray | null = result.match(/(\d+)$/);
		if (match) {
			const num: number = Number(match[1]);
			createdNumbers.push(num);
			previousSubIssue = num;
			log.ok(`Created sub-issue #${num}: ${title}`);
		}
	}

	return createdNumbers;
}

// ---------------------------------------------------------------------------
// PR operations
// ---------------------------------------------------------------------------

export async function createPR(
	title: string,
	body: string,
	baseBranch: string,
	branchName: string,
	worktreePath: string
): Promise<{ ok: boolean; prNumber?: number; error?: string }> {
	try {
		await $`git -C ${worktreePath} push -u origin ${branchName}`.quiet();
	} catch (err) {
		return { ok: false, error: `Failed to push branch: ${err}` };
	}

	try {
		const result =
			await $`gh pr create --title ${title} --body ${body} --base ${baseBranch} --head ${branchName}`.text();
		const match = result.match(/(\d+)/);
		const prNumber = match ? Number(match[1]) : undefined;
		log.ok(`PR created: ${result.trim()}`);
		return { ok: true, prNumber };
	} catch (err) {
		return { ok: false, error: `Failed to create PR: ${err}` };
	}
}

export function determineMergeOrder(prs: MergeOrder[]): MergeOrder[] {
	// Build a map of branch -> PR for dependency resolution
	const branchMap = new Map<string, MergeOrder>();
	for (const pr of prs) {
		branchMap.set(pr.branch, pr);
	}

	// Stacked: if PR A's baseBranch is PR B's branch, B goes first.
	// inStack tracks the current recursion path to detect cycles.
	const visited = new Set<string>();
	const inStack = new Set<string>();
	const result: MergeOrder[] = [];

	function visit(pr: MergeOrder): void {
		if (visited.has(pr.branch)) return;
		if (inStack.has(pr.branch)) {
			throw new Error(
				`Cycle detected in PR dependency graph: ${pr.branch} is part of a circular dependency`
			);
		}

		inStack.add(pr.branch);

		// If this PR's base is another PR in our set, visit that first
		const dep = branchMap.get(pr.baseBranch);
		if (dep) {
			visit(dep);
		}

		inStack.delete(pr.branch);
		visited.add(pr.branch);
		result.push(pr);
	}

	// Sort by issue number for deterministic independent ordering
	const sorted = [...prs].sort((a, b) => a.issueNumber - b.issueNumber);
	for (const pr of sorted) {
		visit(pr);
	}

	return result;
}

export async function discoverMergeablePRs(repoRoot: string): Promise<MergeOrder[]> {
	const stateFile = getStateFilePath(repoRoot, 'orchestrator');
	if (!existsSync(stateFile)) {
		log.error('No orchestrator state found. Run `pait orchestrate` first.');
		return [];
	}

	const raw = readFileSync(stateFile, 'utf-8');

	interface OrchestratorIssueState {
		number: number;
		title: string | null;
		status: string;
		branch: string | null;
		baseBranch: string | null;
		prNumber: number | null;
	}
	interface OrchestratorState {
		issues: Record<number, OrchestratorIssueState>;
	}

	const state: OrchestratorState = JSON.parse(raw);
	const prs: MergeOrder[] = [];

	for (const issue of Object.values(state.issues)) {
		if (issue.status !== 'completed' || !issue.prNumber || !issue.branch) continue;

		// Check if PR is still open
		try {
			const prState = (
				await $`gh pr view ${issue.prNumber} --json state --jq .state`.text()
			).trim();
			if (prState !== 'OPEN') continue;
		} catch {
			continue;
		}

		prs.push({
			issueNumber: issue.number,
			prNumber: issue.prNumber,
			branch: issue.branch,
			baseBranch: issue.baseBranch ?? 'master'
		});
	}

	return prs;
}

export async function mergePR(
	prNumber: number,
	strategy: MergeStrategy,
	dryRun: boolean
): Promise<{ ok: boolean; error?: string }> {
	if (dryRun) {
		log.info(`[DRY RUN] Would merge PR #${prNumber} with --${strategy}`);
		return { ok: true };
	}

	// Retry once — GitHub may need a moment to process a force-push before merge
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await $`gh pr merge ${prNumber} --${strategy} --delete-branch`.quiet();
			return { ok: true };
		} catch (err) {
			if (attempt === 0) {
				log.info('Merge failed, retrying in 3s (GitHub may still be processing)...');
				await Bun.sleep(3000);
			} else {
				return { ok: false, error: String(err) };
			}
		}
	}
	return { ok: false, error: 'Unreachable' };
}
