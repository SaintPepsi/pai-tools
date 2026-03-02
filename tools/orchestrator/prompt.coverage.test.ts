/**
 * Coverage tests for tools/orchestrator/prompt.ts
 *
 * Uses mock OrchestratorPromptDeps to exercise all branches without
 * triggering real readline or log output.
 */

import { describe, test, expect } from 'bun:test';
import { promptForVerifyCommands } from './prompt.ts';
import type { OrchestratorPromptDeps } from './prompt.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(responses: string[]): {
	deps: OrchestratorPromptDeps;
	warns: string[];
	infos: string[];
} {
	const warns: string[] = [];
	const infos: string[] = [];
	let callIndex = 0;

	const deps: OrchestratorPromptDeps = {
		log: {
			warn: (msg) => { warns.push(msg); },
			info: (msg) => { infos.push(msg); },
		},
		promptLine: async (_question: string) => {
			const answer = responses[callIndex] ?? '';
			callIndex++;
			return answer;
		},
	};

	return { deps, warns, infos };
}

// ---------------------------------------------------------------------------
// promptForVerifyCommands
// ---------------------------------------------------------------------------

describe('promptForVerifyCommands', () => {
	test('returns empty array when first prompt is empty', async () => {
		const { deps, warns, infos } = makeDeps(['']);

		const result = await promptForVerifyCommands(deps);

		expect(result).toHaveLength(0);
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain('No verification commands configured');
		expect(infos).toHaveLength(2);
	});

	test('collects one command with provided name', async () => {
		// responses: [cmd1, name1, '' (stop)]
		const { deps } = makeDeps(['bun test', 'test', '']);

		const result = await promptForVerifyCommands(deps);

		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ name: 'test', cmd: 'bun test' });
	});

	test('uses auto-generated name when name prompt is empty', async () => {
		// responses: [cmd1, '' (empty name), '' (stop)]
		const { deps } = makeDeps(['bun tsc --noEmit', '', '']);

		const result = await promptForVerifyCommands(deps);

		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ name: 'verify-1', cmd: 'bun tsc --noEmit' });
	});

	test('collects multiple commands and increments index', async () => {
		// responses: [cmd1, name1, cmd2, name2, '' (stop)]
		const { deps } = makeDeps(['bun test', 'test', 'bun run lint', 'lint', '']);

		const result = await promptForVerifyCommands(deps);

		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ name: 'test', cmd: 'bun test' });
		expect(result[1]).toEqual({ name: 'lint', cmd: 'bun run lint' });
	});

	test('uses auto-generated names for multiple commands when names are empty', async () => {
		// responses: [cmd1, '' (no name), cmd2, '' (no name), '' (stop)]
		const { deps } = makeDeps(['bun test', '', 'bun run lint', '', '']);

		const result = await promptForVerifyCommands(deps);

		expect(result).toHaveLength(2);
		expect(result[0].name).toBe('verify-1');
		expect(result[1].name).toBe('verify-2');
	});

	test('logs all three required messages on entry', async () => {
		const { deps, warns, infos } = makeDeps(['']);

		await promptForVerifyCommands(deps);

		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain('No verification commands configured');
		expect(infos).toHaveLength(2);
		expect(infos[0]).toContain('orchestrator requires verification steps');
		expect(infos[1]).toContain('Common examples');
	});
});
