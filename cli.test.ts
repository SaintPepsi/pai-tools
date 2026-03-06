import { describe, test, expect, beforeAll } from 'bun:test';
import { join } from 'node:path';

describe('CLI help text sync', () => {
	let cliSource = '';
	let orchestratorSource = '';
	let analyzeSource = '';
	let verifySource = '';
	let finalizeSource = '';
	let depsSource = '';

	beforeAll(async () => {
		const dir = import.meta.dir;
		[cliSource, orchestratorSource, analyzeSource, verifySource, finalizeSource, depsSource] =
			await Promise.all([
				Bun.file(join(dir, 'cli.ts')).text(),
				Bun.file(join(dir, 'tools/orchestrator/flags.ts')).text(),
				Bun.file(join(dir, 'tools/analyze/flags.ts')).text(),
				Bun.file(join(dir, 'tools/verify/index.ts')).text(),
				Bun.file(join(dir, 'tools/finalize/index.ts')).text(),
				Bun.file(join(dir, 'tools/deps/flags.ts')).text(),
			]);
	});

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

	test('every deps flag in parseDepsFlags appears in CLI HELP', () => {
		const parseFlagsMatch = depsSource.match(
			/function parseDepsFlags[\s\S]*?^}/m
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
				`Deps flags missing from CLI help text: ${missing.join(', ')}\n` +
					'Update the HELP string in cli.ts to include these flags.'
			);
		}
	});
});

describe('Tool README flag sync', () => {
	function extractFlags(source: string, fnName: string): string[] {
		const match = source.match(new RegExp(`function ${fnName}[\\s\\S]*?^}`, 'm'));
		if (!match) return [];
		return [...match[0].matchAll(/'(--[\w-]+)'/g)]
			.map((m) => m[1])
			.filter((f) => f !== '--help');
	}

	const tools = [
		{ name: 'orchestrator', fn: 'parseFlags', dir: 'tools/orchestrator', file: 'flags.ts' },
		{ name: 'analyze', fn: 'parseAnalyzeFlags', dir: 'tools/analyze', file: 'flags.ts' },
		{ name: 'verify', fn: 'parseVerifyFlags', dir: 'tools/verify', file: 'index.ts' },
		{ name: 'finalize', fn: 'parseFinalizeFlags', dir: 'tools/finalize', file: 'index.ts' },
		{ name: 'deps', fn: 'parseDepsFlags', dir: 'tools/deps', file: 'flags.ts' },
	];

	for (const tool of tools) {
		const readmePath = join(import.meta.dir, tool.dir, 'README.md');

		test(`every ${tool.name} flag appears in ${tool.dir}/README.md`, async () => {
			const readmeFile = Bun.file(readmePath);
			if (!(await readmeFile.exists())) return;

			const toolSource = await Bun.file(join(import.meta.dir, tool.dir, tool.file)).text();
			const flags = extractFlags(toolSource, tool.fn);
			const toolReadme = await readmeFile.text();

			expect(flags.length).toBeGreaterThan(0);

			const missing = flags.filter((flag) => !toolReadme.includes(flag));
			if (missing.length > 0) {
				throw new Error(
					`${tool.name} flags missing from ${tool.dir}/README.md: ${missing.join(', ')}\n` +
						`Update ${tool.dir}/README.md to include these flags.`
				);
			}
		});
	}
});
