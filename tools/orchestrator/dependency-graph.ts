/**
 * Dependency graph utilities for the issue orchestrator.
 *
 * Pure functions: no I/O, no side effects.
 * Parses issue dependencies, builds directed graphs, and topologically sorts them.
 */

import type { GitHubIssue, DependencyNode, OrchestratorConfig } from './types.ts';

export function parseDependencies(body: string): number[] {
	const depLine = body.split('\n').find((line) => /depends\s+on/i.test(line));
	if (!depLine) return [];

	const matches = depLine.matchAll(/#(\d+)/g);
	return [...matches].map((m) => Number(m[1]));
}

export function toKebabSlug(title: string): string {
	return title
		.toLowerCase()
		.replace(/^\[\d+\]\s*/, '')
		.replace(/[^a-z0-9]+/g, '-')
		.slice(0, 50)
		.replace(/^-|-$/g, '');
}

export function buildGraph(
	issues: GitHubIssue[],
	config: OrchestratorConfig
): Map<number, DependencyNode> {
	const graph = new Map<number, DependencyNode>();

	for (const issue of issues) {
		const deps = parseDependencies(issue.body);
		graph.set(issue.number, {
			issue,
			dependsOn: deps,
			branch: `${config.branchPrefix}${issue.number}-${toKebabSlug(issue.title)}`
		});
	}

	return graph;
}

/**
 * Assign each issue to the earliest tier where all its deps are in earlier tiers.
 * Tier 0 = no in-graph deps; Tier N = all deps in tiers 0..N-1.
 * Returns an array of tiers, each tier being an array of issue numbers.
 */
export function computeTiers(graph: Map<number, DependencyNode>): number[][] {
	const tierOf = new Map<number, number>();

	function getTier(num: number): number {
		if (tierOf.has(num)) return tierOf.get(num)!;
		const node = graph.get(num);
		if (!node) return -1;
		const inGraphDeps = node.dependsOn.filter((d) => graph.has(d));
		const myTier =
			inGraphDeps.length === 0 ? 0 : Math.max(...inGraphDeps.map((d) => getTier(d))) + 1;
		tierOf.set(num, myTier);
		return myTier;
	}

	for (const num of graph.keys()) {
		getTier(num);
	}

	const tiers: number[][] = [];
	for (const [num, tier] of tierOf) {
		while (tiers.length <= tier) tiers.push([]);
		tiers[tier].push(num);
	}

	return tiers;
}

export function topologicalSort(graph: Map<number, DependencyNode>): number[] {
	const visited = new Set<number>();
	const visiting = new Set<number>();
	const result: number[] = [];

	function visit(num: number): void {
		if (visited.has(num)) return;
		if (visiting.has(num)) {
			throw new Error(`Circular dependency detected involving issue #${num}`);
		}

		visiting.add(num);

		const node = graph.get(num);
		if (node) {
			for (const dep of node.dependsOn) {
				if (graph.has(dep)) {
					visit(dep);
				}
			}
		}

		visiting.delete(num);
		visited.add(num);
		result.push(num);
	}

	for (const num of graph.keys()) {
		visit(num);
	}

	return result;
}
