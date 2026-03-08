/**
 * Orchestrator state helpers — initializes and accesses per-issue state.
 *
 * Extracted to break the circular dependency between index.ts and execution.ts.
 */

import type { IssueState, OrchestratorState } from '@tools/orchestrator/types.ts';

export interface SplitCompletionResult {
	parentNumber: number;
	allComplete: boolean;
}

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
