/**
 * Orchestrator state helpers — initializes and accesses per-issue state.
 *
 * Extracted to break the circular dependency between index.ts and execution.ts.
 */

import type { IssueState, OrchestratorState } from './types.ts';

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
