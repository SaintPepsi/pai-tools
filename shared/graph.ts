/**
 * Domain-agnostic graph utilities shared across tools.
 *
 * Pure functions: no I/O, no side effects.
 */

/**
 * Sort items so that prerequisites appear before their dependents.
 * Falls back to original order for items without dependencies.
 *
 * Cycle handling: when a back-edge is detected (key already in the `visiting`
 * set), the node that triggered the cycle is appended to the output immediately
 * so it is never silently dropped. This means cycles degrade gracefully to an
 * arbitrary-but-complete ordering rather than losing items.
 *
 * @param items       Array of items, each with a `key` string for identity.
 * @param dependencies Map from a key to the set of keys it depends on
 *                     (i.e. prerequisites that must appear earlier in the output).
 */
export function topologicalSort<T extends { key: string }>(
	items: T[],
	dependencies: Map<string, Set<string>>,
): T[] {
	if (dependencies.size === 0) return items;

	const result: T[] = [];
	const inResult = new Set<string>();
	const visiting = new Set<string>();

	const byKey = new Map(items.map((item) => [item.key, item]));

	function visit(key: string): void {
		if (inResult.has(key)) return;
		if (visiting.has(key)) {
			// Cycle detected — add the node now so it is never silently dropped.
			// It will appear before its own prerequisites in the output, which
			// is unavoidable when a genuine cycle exists.
			if (byKey.has(key)) {
				result.push(byKey.get(key)!);
				inResult.add(key);
			}
			return;
		}

		visiting.add(key);

		const prereqs = dependencies.get(key);
		if (prereqs) {
			for (const prereq of prereqs) {
				if (byKey.has(prereq)) {
					visit(prereq);
				}
			}
		}

		visiting.delete(key);
		if (byKey.has(key) && !inResult.has(key)) {
			result.push(byKey.get(key)!);
			inResult.add(key);
		}
	}

	for (const { key } of items) {
		visit(key);
	}

	return result;
}
