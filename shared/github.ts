/**
 * Shared GitHub helpers — all gh CLI operations consolidated here.
 *
 * Import from this module, not from tool-specific files, when working
 * with GitHub issues or PRs via the gh CLI.
 */

import { log } from './log.ts';
import { getStateFilePath } from './config.ts';
import type { FsAdapter } from './adapters/fs.ts';
import { defaultFsAdapter } from './adapters/fs.ts';

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
// Dependency injection
// ---------------------------------------------------------------------------

export interface GithubDeps {
	/** Run a shell command, returning exit code + captured stdout/stderr. */
	exec: (cmd: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
	/** Filesystem operations. */
	fs: FsAdapter;
	/** Sleep for the given number of milliseconds. */
	sleep: (ms: number) => Promise<void>;
}

async function defaultExec(cmd: string[]) {
	const proc = Bun.spawnSync(cmd);
	return {
		exitCode: proc.exitCode ?? 1,
		stdout: proc.stdout?.toString() ?? '',
		stderr: proc.stderr?.toString() ?? '',
	};
}

const defaultDeps: GithubDeps = {
	exec: defaultExec,
	fs: defaultFsAdapter,
	sleep: Bun.sleep,
};

export const defaultGithubDeps: GithubDeps = defaultDeps;

// ---------------------------------------------------------------------------
// Issue operations
// ---------------------------------------------------------------------------

export async function fetchOpenIssues(allowedAuthors?: string[], deps: GithubDeps = defaultDeps): Promise<GitHubIssue[]> {
	let authors: string[];
	if (allowedAuthors?.length) {
		authors = allowedAuthors;
	} else {
		const r = await deps.exec(['gh', 'api', 'user', '--jq', '.login']);
		authors = [r.stdout.trim()];
	}

	log.info(`Filtering issues by author(s): ${authors.join(', ')}`);

	const seen = new Set<number>();
	const issues: GitHubIssue[] = [];

	for (const author of authors) {
		const r = await deps.exec([
			'gh', 'issue', 'list',
			'--state', 'open',
			'--limit', '200',
			'--author', author,
			'--json', 'number,title,body,state,labels',
		]);
		for (const issue of JSON.parse(r.stdout) as GitHubIssue[]) {
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
	parentDeps: number[],
	deps: GithubDeps = defaultDeps
): Promise<number[]> {
	const createdNumbers: number[] = [];
	let previousSubIssue: number | null = null;

	for (const split of splits) {
		const issueDeps: number[] =
			previousSubIssue !== null
				? [previousSubIssue]
				: parentDeps.filter((d: number) => d !== parentIssue.number);

		const depsLine: string =
			issueDeps.length > 0 ? `> **Depends on:** ${issueDeps.map((d: number) => `#${d}`).join(', ')}\n\n` : '';

		const issueBody: string = `${depsLine}> **Part of** #${parentIssue.number}\n\n${split.body}`;

		const r = await deps.exec(['gh', 'issue', 'create', '--title', split.title, '--body', issueBody]);
		const match: RegExpMatchArray | null = r.stdout.trim().match(/(\d+)$/);
		if (match) {
			const num: number = Number(match[1]);
			createdNumbers.push(num);
			previousSubIssue = num;
			log.ok(`Created sub-issue #${num}: ${split.title}`);
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
	worktreePath: string,
	deps: GithubDeps = defaultDeps
): Promise<{ ok: boolean; prNumber?: number; error?: string }> {
	const push = await deps.exec(['git', '-C', worktreePath, 'push', '-u', 'origin', branchName]);
	if (push.exitCode !== 0) {
		return { ok: false, error: `Failed to push branch: ${push.stderr}` };
	}

	const pr = await deps.exec([
		'gh', 'pr', 'create',
		'--title', title,
		'--body', body,
		'--base', baseBranch,
		'--head', branchName,
	]);
	if (pr.exitCode !== 0) {
		return { ok: false, error: `Failed to create PR: ${pr.stderr}` };
	}

	const match = pr.stdout.match(/(\d+)/);
	const prNumber = match ? Number(match[1]) : undefined;
	log.ok(`PR created: ${pr.stdout.trim()}`);
	return { ok: true, prNumber };
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

export async function discoverMergeablePRs(repoRoot: string, deps: GithubDeps = defaultDeps): Promise<MergeOrder[]> {
	const stateFile = getStateFilePath(repoRoot, 'orchestrator');
	if (!deps.fs.fileExists(stateFile)) {
		log.error('No orchestrator state found. Run `pait orchestrate` first.');
		return [];
	}

	const raw = deps.fs.readFile(stateFile);

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
		const r = await deps.exec(['gh', 'pr', 'view', String(issue.prNumber), '--json', 'state', '--jq', '.state']);
		if (r.exitCode !== 0 || r.stdout.trim() !== 'OPEN') continue;

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
	dryRun: boolean,
	deps: GithubDeps = defaultDeps
): Promise<{ ok: boolean; error?: string }> {
	if (dryRun) {
		log.info(`[DRY RUN] Would merge PR #${prNumber} with --${strategy}`);
		return { ok: true };
	}

	// Retry once — GitHub may need a moment to process a force-push before merge
	const first = await deps.exec(['gh', 'pr', 'merge', String(prNumber), `--${strategy}`, '--delete-branch']);
	if (first.exitCode === 0) {
		return { ok: true };
	}
	log.info('Merge failed, retrying in 3s (GitHub may still be processing)...');
	await deps.sleep(3000);
	const second = await deps.exec(['gh', 'pr', 'merge', String(prNumber), `--${strategy}`, '--delete-branch']);
	if (second.exitCode === 0) {
		return { ok: true };
	}
	return { ok: false, error: second.stderr };
}
