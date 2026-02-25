/**
 * PR discovery and merge ordering for the finalize tool.
 *
 * - discoverMergeablePRs: reads orchestrator state, returns open PRs ready to merge
 * - determineMergeOrder: topological sort for stacked PR dependencies
 */

import type { MergeOrder } from '../../shared/github.ts';

export { discoverMergeablePRs } from '../../shared/github.ts';

export function determineMergeOrder(prs: MergeOrder[]): MergeOrder[] {
	// Build a map of branch -> PR for dependency resolution
	const branchMap = new Map<string, MergeOrder>();
	for (const pr of prs) {
		branchMap.set(pr.branch, pr);
	}

	// Stacked: if PR A's baseBranch is PR B's branch, B goes first
	const visited = new Set<string>();
	const result: MergeOrder[] = [];

	function visit(pr: MergeOrder): void {
		if (visited.has(pr.branch)) return;
		visited.add(pr.branch);

		// If this PR's base is another PR in our set, visit that first
		const dep = branchMap.get(pr.baseBranch);
		if (dep) {
			visit(dep);
		}

		result.push(pr);
	}

	// Sort by issue number for deterministic independent ordering
	const sorted = [...prs].sort((a, b) => a.issueNumber - b.issueNumber);
	for (const pr of sorted) {
		visit(pr);
	}

	return result;
}
