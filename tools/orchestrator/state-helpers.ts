/**
 * Orchestrator state helpers — initializes and accesses per-issue state.
 *
 * Extracted to break the circular dependency between index.ts and execution.ts.
 */

import type { IssueState, OrchestratorState } from '@tools/orchestrator/types.ts';
import { log as sharedLog } from '@shared/log.ts';

export interface SplitCompletionResult {
	parentNumber: number;
	allComplete: boolean;
}

export interface ReconciliationDeps {
	exec: (cmd: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
	log: { info: (msg: string) => void; warn: (msg: string) => void; ok: (msg: string) => void };
}

export const defaultReconciliationDeps: ReconciliationDeps = {
	exec: async (cmd) => {
		const proc = Bun.spawnSync(cmd);
		return {
			exitCode: proc.exitCode ?? 1,
			stdout: proc.stdout?.toString() ?? '',
			stderr: proc.stderr?.toString() ?? '',
		};
	},
	log: {
		info: (msg) => sharedLog.info(msg),
		warn: (msg) => sharedLog.warn(msg),
		ok: (msg) => sharedLog.ok(msg),
	},
};

export function initState(): OrchestratorState {
	return {
		version: 1,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		issues: {}
	};
}

export function getIssueState(state: OrchestratorState, num: number, title?: string): IssueState {
	if (!state.issues[num]) {
		state.issues[num] = {
			number: num,
			title: title ?? null,
			status: 'pending',
			branch: null,
			baseBranch: null,
			prNumber: null,
			error: null,
			completedAt: null,
			subIssues: null
		};
	} else if (title && !state.issues[num].title) {
		state.issues[num].title = title;
	}
	return state.issues[num];
}

export function checkSplitParentCompletion(
	state: OrchestratorState,
	completedIssueNumber: number
): SplitCompletionResult | null {
	// Find a split parent whose subIssues array contains this issue
	for (const [numStr, issueState] of Object.entries(state.issues)) {
		if (
			issueState.status === 'split' &&
			issueState.subIssues?.includes(completedIssueNumber)
		) {
			const parentNumber = Number(numStr);
			const allComplete = issueState.subIssues.every(
				(sub) => state.issues[sub]?.status === 'completed'
			);

			if (allComplete) {
				issueState.status = 'completed';
				issueState.completedAt = new Date().toISOString();
			}

			return { parentNumber, allComplete };
		}
	}

	return null;
}

export async function reconcileWithGitHub(
	state: OrchestratorState,
	repoRoot: string,
	deps: ReconciliationDeps = defaultReconciliationDeps,
): Promise<string[]> {
	const corrections: string[] = [];

	for (const [numStr, issueState] of Object.entries(state.issues)) {
		const num = Number(numStr);

		// Check completed issues: is the PR still valid?
		if (issueState.status === 'completed' && issueState.prNumber) {
			const r = await deps.exec([
				'gh', 'pr', 'view', String(issueState.prNumber), '--json', 'state', '--jq', '.state',
			]);
			if (r.exitCode !== 0) continue;

			const prState = r.stdout.trim().toUpperCase();
			if (prState === 'CLOSED') {
				issueState.status = 'failed';
				issueState.error = 'PR was closed without merge — reset by reconciliation';
				const msg = `#${num}: PR #${issueState.prNumber} closed without merge → reset to failed`;
				deps.log.warn(msg);
				corrections.push(msg);
			}
		}

		// Check split parents: are all sub-issues closed on GitHub?
		if (issueState.status === 'split' && issueState.subIssues?.length) {
			let allClosed = true;
			for (const sub of issueState.subIssues) {
				const r = await deps.exec([
					'gh', 'issue', 'view', String(sub), '--json', 'state', '--jq', '.state',
				]);
				if (r.exitCode !== 0) { allClosed = false; break; }
				if (r.stdout.trim().toLowerCase() !== 'closed') { allClosed = false; break; }
			}

			if (allClosed) {
				issueState.status = 'completed';
				issueState.completedAt = new Date().toISOString();
				const msg = `#${num}: all sub-issues closed → parent marked completed`;
				deps.log.ok(msg);
				corrections.push(msg);
			}
		}

		// Check in_progress: does the branch still exist?
		if (issueState.status === 'in_progress' && issueState.branch) {
			const r = await deps.exec([
				'git', '-C', repoRoot, 'branch', '--list', issueState.branch,
			]);
			if (r.exitCode !== 0) continue;

			if (!r.stdout.trim()) {
				const branchName = issueState.branch;
				issueState.status = 'pending';
				issueState.branch = null;
				issueState.baseBranch = null;
				const msg = `#${num}: branch ${branchName} gone → reset to pending`;
				deps.log.warn(msg);
				corrections.push(msg);
			}
		}
	}

	if (corrections.length > 0) {
		deps.log.info(`Reconciliation made ${corrections.length} correction(s)`);
	}

	return corrections;
}
