/**
 * Dependency graph building and validation for the deps tool.
 */

import type { IssueRelationships } from 'tools/deps/types.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Adjacency map: issue number → list of issue numbers it is blocked by. */
export type DepsGraph = Map<number, number[]>;

/** Result of graph validation. */
export interface GraphValidation {
	/** Each entry is a sequence of issue numbers forming a dependency cycle. */
	cycles: number[][];
	/** Issue numbers referenced as blockers but not present in the graph. */
	missing: number[];
	/** True when no cycles and no missing deps are found. */
	valid: boolean;
}

// ─── buildDepsGraph ───────────────────────────────────────────────────────────

/**
 * Build an adjacency map from a flat list of issue relationships.
 * Each key is an issue number; its value is the list of issue numbers
 * that must be resolved before it can start (its `blockedBy` array).
 */
export function buildDepsGraph(issues: IssueRelationships[]): DepsGraph {
	const graph: DepsGraph = new Map();
	for (const issue of issues) {
		graph.set(issue.number, issue.blockedBy);
	}
	return graph;
}

// ─── validateGraph ────────────────────────────────────────────────────────────

/**
 * Validate a dependency graph for cycles and missing dependencies.
 * Cycle detection uses iterative DFS with an explicit path stack.
 */
export function validateGraph(graph: DepsGraph): GraphValidation {
	const known = new Set(graph.keys());

	// ── Missing deps ──────────────────────────────────────────────────────────
	const missingSet = new Set<number>();
	for (const deps of graph.values()) {
		for (const dep of deps) {
			if (!known.has(dep)) {
				missingSet.add(dep);
			}
		}
	}

	// ── Cycle detection via DFS ───────────────────────────────────────────────
	const cycles: number[][] = [];
	const visited = new Set<number>();
	const pathSet = new Set<number>();

	function dfs(node: number, path: number[]): void {
		if (pathSet.has(node)) {
			const idx = path.indexOf(node);
			cycles.push([...path.slice(idx)]);
			return;
		}
		if (visited.has(node)) return;

		pathSet.add(node);
		path.push(node);

		for (const dep of graph.get(node) ?? []) {
			if (known.has(dep) || pathSet.has(dep)) {
				dfs(dep, path);
			}
		}

		path.pop();
		pathSet.delete(node);
		visited.add(node);
	}

	for (const node of graph.keys()) {
		if (!visited.has(node)) {
			dfs(node, []);
		}
	}

	return {
		cycles,
		missing: [...missingSet],
		valid: cycles.length === 0 && missingSet.size === 0,
	};
}

// ─── computeTiers ─────────────────────────────────────────────────────────────

/**
 * Group issues into parallelizable execution tiers via topological layering.
 * Tier 0 contains issues with no unresolved blockers; each subsequent tier
 * contains issues whose blockers all appear in earlier tiers.
 *
 * If the graph contains cycles or unresolvable issues, the remaining nodes
 * are collected into a final tier rather than looping forever.
 */
export function computeTiers(graph: DepsGraph): number[][] {
	if (graph.size === 0) return [];

	const tiers: number[][] = [];
	const resolved = new Set<number>();
	let remaining = [...graph.keys()];

	while (remaining.length > 0) {
		const ready = remaining.filter(issue =>
			(graph.get(issue) ?? []).every(dep => resolved.has(dep)),
		);

		if (ready.length === 0) {
			// Cycle or unresolvable deps — dump the rest into a final tier.
			tiers.push([...remaining]);
			break;
		}

		tiers.push(ready);
		for (const issue of ready) resolved.add(issue);
		remaining = remaining.filter(issue => !resolved.has(issue));
	}

	return tiers;
}
