/**
 * Terminal rendering helpers for the issue orchestrator.
 *
 * Stateless display functions — no I/O beyond terminal output.
 */

import { log } from '../../shared/log.ts';
import type { DependencyNode, OrchestratorState } from './types.ts';

export function printParallelPlan(
	tiers: number[][],
	graph: Map<number, DependencyNode>,
	parallelN: number
): void {
	log.step(`EXECUTION PLAN (parallel: ${parallelN})`);
	for (let t = 0; t < tiers.length; t++) {
		const tier = tiers[t];
		const concurrent = Math.min(tier.length, parallelN);
		const afterLabel = t === 0 ? '' : `, after tier ${t - 1}`;
		console.log(`  Tier ${t} (${concurrent} concurrent${afterLabel}):`);
		for (const num of tier) {
			const node = graph.get(num);
			if (!node) continue;
			const deps =
				node.dependsOn.length > 0
					? ` (deps: ${node.dependsOn.map((d) => `#${d}`).join(', ')})`
					: ' (no deps)';
			console.log(`    #${num} ${node.issue.title}${deps}`);
		}
	}
	const total = tiers.reduce((sum, t) => sum + t.length, 0);
	console.log(`\n  Total: ${total} issues across ${tiers.length} tier(s)`);
}

export function printExecutionPlan(order: number[], graph: Map<number, DependencyNode>, baseBranch = 'master'): void {
	log.step('EXECUTION PLAN');
	for (let i = 0; i < order.length; i++) {
		const num = order[i];
		const node = graph.get(num);
		if (!node) continue;

		const deps =
			node.dependsOn.length > 0
				? ` (deps: ${node.dependsOn.map((d) => `#${d}`).join(', ')})`
				: ` (no deps — branches from ${baseBranch})`;
		console.log(`  ${(i + 1).toString().padStart(2)}. #${num} ${node.issue.title}${deps}`);
		log.dim(`      → branch: ${node.branch}`);
	}
	console.log(`\n  Total: ${order.length} issues`);
}

export function printStatus(state: OrchestratorState): void {
	log.step('ORCHESTRATOR STATUS');
	const entries = Object.values(state.issues).sort((a, b) => a.number - b.number);
	const completed = entries.filter((e) => e.status === 'completed').length;
	const failed = entries.filter((e) => e.status === 'failed').length;
	const blocked = entries.filter((e) => e.status === 'blocked').length;
	const pending = entries.filter((e) => e.status === 'pending').length;

	console.log(`  Started: ${state.startedAt}`);
	console.log(`  Updated: ${state.updatedAt}`);
	const blockedLabel = blocked > 0 ? `, ${blocked} blocked` : '';
	console.log(`  Progress: ${completed} completed, ${failed} failed${blockedLabel}, ${pending} pending\n`);

	for (const entry of entries) {
		const icon =
			entry.status === 'completed'
				? '\x1b[32m✓\x1b[0m'
				: entry.status === 'failed'
					? '\x1b[31m✗\x1b[0m'
					: entry.status === 'split'
						? '\x1b[33m↔\x1b[0m'
						: entry.status === 'blocked'
							? '\x1b[31m⊘\x1b[0m'
							: '\x1b[2m○\x1b[0m';
		const titleStr = entry.title ? ` ${entry.title}` : '';
		const extra = entry.prNumber ? ` → PR #${entry.prNumber}` : '';
		const errMsg = entry.error ? `\n      \x1b[31m${entry.error}\x1b[0m` : '';
		console.log(`  ${icon} #${entry.number}${titleStr} [${entry.status}]${extra}${errMsg}`);
	}
}
