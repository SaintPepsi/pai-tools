import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('CLI help text sync', () => {
	const cliSource = readFileSync(join(import.meta.dir, 'cli.ts'), 'utf-8');
	const orchestratorSource = readFileSync(
		join(import.meta.dir, 'tools/orchestrator/index.ts'),
		'utf-8'
	);
	const analyzeSource = readFileSync(
		join(import.meta.dir, 'tools/analyze/index.ts'),
		'utf-8'
	);
	const verifySource = readFileSync(
		join(import.meta.dir, 'tools/verify/index.ts'),
		'utf-8'
	);
	const finalizeSource = readFileSync(
		join(import.meta.dir, 'tools/finalize/index.ts'),
		'utf-8'
	);

	test('every orchestrator flag in parseFlags appears in CLI HELP', () => {
		// Extract all --flag-name patterns from parseFlags function
		const parseFlagsMatch = orchestratorSource.match(
			/function parseFlags[\s\S]*?^}/m
		);
		expect(parseFlagsMatch).not.toBeNull();

		const flagMatches = parseFlagsMatch![0].matchAll(/'(--[\w-]+)'/g);
		const flags = [...flagMatches].map((m) => m[1]);

		expect(flags.length).toBeGreaterThan(0);

		// Extract the HELP string from cli.ts
		const helpMatch = cliSource.match(/const HELP = `[\s\S]*?`;/);
		expect(helpMatch).not.toBeNull();
		const helpText = helpMatch![0];

		const missing = flags.filter((flag) => !helpText.includes(flag));
		if (missing.length > 0) {
			throw new Error(
				`Orchestrator flags missing from CLI help text: ${missing.join(', ')}\n` +
					'Update the HELP string in cli.ts to include these flags.'
			);
		}
	});

	test('every analyze flag in parseAnalyzeFlags appears in CLI HELP', () => {
		const parseFlagsMatch = analyzeSource.match(
			/function parseAnalyzeFlags[\s\S]*?^}/m
		);
		expect(parseFlagsMatch).not.toBeNull();

		const flagMatches = parseFlagsMatch![0].matchAll(/'(--[\w-]+)'/g);
		const flags = [...flagMatches].map((m) => m[1]);

		expect(flags.length).toBeGreaterThan(0);

		const helpMatch = cliSource.match(/const HELP = `[\s\S]*?`;/);
		expect(helpMatch).not.toBeNull();
		const helpText = helpMatch![0];

		// --help is a meta-flag handled globally, not listed per-command
		const missing = flags
			.filter((flag) => flag !== '--help')
			.filter((flag) => !helpText.includes(flag));
		if (missing.length > 0) {
			throw new Error(
				`Analyze flags missing from CLI help text: ${missing.join(', ')}\n` +
					'Update the HELP string in cli.ts to include these flags.'
			);
		}
	});

	test('every verify flag in parseVerifyFlags appears in CLI HELP', () => {
		const parseFlagsMatch = verifySource.match(
			/function parseVerifyFlags[\s\S]*?^}/m
		);
		expect(parseFlagsMatch).not.toBeNull();

		const flagMatches = parseFlagsMatch![0].matchAll(/'(--[\w-]+)'/g);
		const flags = [...flagMatches].map((m) => m[1]);

		expect(flags.length).toBeGreaterThan(0);

		const helpMatch = cliSource.match(/const HELP = `[\s\S]*?`;/);
		expect(helpMatch).not.toBeNull();
		const helpText = helpMatch![0];

		const missing = flags
			.filter((flag) => flag !== '--help')
			.filter((flag) => !helpText.includes(flag));
		if (missing.length > 0) {
			throw new Error(
				`Verify flags missing from CLI help text: ${missing.join(', ')}\n` +
					'Update the HELP string in cli.ts to include these flags.'
			);
		}
	});

	test('every finalize flag in parseFinalizeFlags appears in CLI HELP', () => {
		const parseFlagsMatch = finalizeSource.match(
			/function parseFinalizeFlags[\s\S]*?^}/m
		);
		expect(parseFlagsMatch).not.toBeNull();

		const flagMatches = parseFlagsMatch![0].matchAll(/'(--[\w-]+)'/g);
		const flags = [...flagMatches].map((m) => m[1]);

		expect(flags.length).toBeGreaterThan(0);

		const helpMatch = cliSource.match(/const HELP = `[\s\S]*?`;/);
		expect(helpMatch).not.toBeNull();
		const helpText = helpMatch![0];

		const missing = flags
			.filter((flag) => flag !== '--help')
			.filter((flag) => !helpText.includes(flag));
		if (missing.length > 0) {
			throw new Error(
				`Finalize flags missing from CLI help text: ${missing.join(', ')}\n` +
					'Update the HELP string in cli.ts to include these flags.'
			);
		}
	});
});
