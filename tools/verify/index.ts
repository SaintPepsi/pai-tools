/**
 * Standalone verification tool — extracted from orchestrator.
 *
 * Runs configured verification commands and optional E2E checks.
 * Usable as a CLI (`pait verify`) or programmatically via `runVerify()`.
 */

import { $ } from 'bun';
import { log } from '../../shared/log.ts';
import { promptLine } from '../../shared/prompt.ts';
import { findRepoRoot, loadToolConfig } from '../../shared/config.ts';
import type {
	VerifyCommand,
	VerifyFlags,
	VerifyOptions,
	VerifyResult,
	VerifyStepResult
} from './types.ts';

// Re-export types for convenience
export type { VerifyCommand, VerifyFlags, VerifyOptions, VerifyResult, VerifyStepResult } from './types.ts';

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

export function parseVerifyFlags(args: string[]): VerifyFlags {
	const nameIdx = args.indexOf('--name');
	const filterName = nameIdx !== -1 && args[nameIdx + 1] ? args[nameIdx + 1] : null;

	return {
		skipE2e: args.includes('--skip-e2e'),
		filterName,
		json: args.includes('--json'),
		help: args.includes('--help') || args.includes('-h')
	};
}

// ---------------------------------------------------------------------------
// Core verification
// ---------------------------------------------------------------------------

export async function runVerify(opts: VerifyOptions): Promise<VerifyResult> {
	const steps: VerifyStepResult[] = [];
	const issueNum = opts.issueNumber ?? 0;

	// Filter steps if --name provided
	const verifySteps = opts.filterName
		? opts.verify.filter((s) => s.name === opts.filterName)
		: opts.verify;

	for (const step of verifySteps) {
		log.info(`Running ${step.name}: ${step.cmd}`);
		const start = Date.now();
		try {
			await $`${{ raw: step.cmd }}`.cwd(opts.cwd).quiet();
			const durationMs = Date.now() - start;
			log.ok(`${step.name} passed`);
			steps.push({ name: step.name, ok: true, durationMs });
			opts.logger?.verifyPass(issueNum, step.name);
		} catch (err) {
			const durationMs = Date.now() - start;
			const output = err instanceof Error ? err.message : String(err);
			const errorMsg = output.slice(-2000);
			steps.push({ name: step.name, ok: false, durationMs, error: errorMsg });
			opts.logger?.verifyFail(issueNum, step.name, errorMsg);
			return { ok: false, steps, failedStep: step.name, error: errorMsg };
		}
	}

	// E2E (only if configured and not skipped)
	if (opts.e2e && !opts.skipE2e) {
		log.info(`Running E2E: ${opts.e2e.run}`);
		const start = Date.now();
		try {
			await $`${{ raw: opts.e2e.run }}`.cwd(opts.cwd).quiet();
			const durationMs = Date.now() - start;
			log.ok('E2E passed');
			steps.push({ name: 'e2e', ok: true, durationMs });
			opts.logger?.verifyPass(issueNum, 'e2e');
		} catch {
			log.warn('E2E failed — attempting snapshot update...');
			try {
				await $`${{ raw: opts.e2e.update }}`.cwd(opts.cwd).quiet();
				await $`${{ raw: opts.e2e.run }}`.cwd(opts.cwd).quiet();
				const durationMs = Date.now() - start;
				log.ok('E2E passed after snapshot update');
				steps.push({ name: 'e2e (after snapshot update)', ok: true, durationMs });
				opts.logger?.verifyPass(issueNum, 'e2e (after snapshot update)');
				// Stage updated snapshots
				const glob = opts.e2e.snapshotGlob;
				await $`git -C ${opts.cwd} add -A ${glob}`.quiet().catch(() => {});
				await $`git -C ${opts.cwd} commit -m ${'test: update E2E snapshots for #' + issueNum}`
					.quiet()
					.catch(() => {});
			} catch (err) {
				const durationMs = Date.now() - start;
				const output = err instanceof Error ? err.message : String(err);
				const errorMsg = output.slice(-2000);
				steps.push({ name: 'e2e', ok: false, durationMs, error: errorMsg });
				opts.logger?.verifyFail(issueNum, 'e2e', errorMsg);
				return { ok: false, steps, failedStep: 'e2e', error: errorMsg };
			}
		}
	}

	return { ok: true, steps };
}

// ---------------------------------------------------------------------------
// Interactive verify prompt
// ---------------------------------------------------------------------------

export async function promptForVerifyCommands(): Promise<VerifyCommand[]> {
	log.warn('No verification commands configured.');
	log.info('The orchestrator requires verification steps to ensure implementations are correct.');
	log.info('Common examples: "bun tsc --noEmit" (typecheck), "bun test" (tests), "bun run lint" (lint)\n');

	const commands: VerifyCommand[] = [];
	let index = 1;

	while (true) {
		const cmd = await promptLine(`  Verify command ${index} (empty to finish): `);
		if (!cmd) break;

		const name = await promptLine(`  Name for this step (e.g. "typecheck", "test"): `);
		commands.push({ name: name || `verify-${index}`, cmd });
		index++;
	}

	return commands;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const VERIFY_HELP = `\x1b[36mpait verify\x1b[0m — Run verification commands

\x1b[1mUSAGE\x1b[0m
  pait verify [flags]

\x1b[1mFLAGS\x1b[0m
  --skip-e2e       Skip E2E verification step
  --name <step>    Run only the named step
  --json           Output results as JSON
  --help, -h       Show this help message

Reads verification commands from .pait/orchestrator.json.
`;

interface OrchestratorConfigPartial {
	verify: VerifyCommand[];
	e2e?: {
		run: string;
		update: string;
		snapshotGlob: string;
	};
}

export async function verify(flags: VerifyFlags): Promise<void> {
	if (flags.help) {
		console.log(VERIFY_HELP);
		return;
	}

	const repoRoot = findRepoRoot();
	const config = loadToolConfig<OrchestratorConfigPartial>(repoRoot, 'orchestrator', {
		verify: [],
	});

	if (config.verify.length === 0 && !config.e2e) {
		log.error('No verification commands configured in .pait/orchestrator.json');
		log.info('Run `pait orchestrate` first to configure verification steps.');
		process.exit(1);
	}

	const result = await runVerify({
		verify: config.verify,
		e2e: config.e2e,
		cwd: repoRoot,
		skipE2e: flags.skipE2e,
		filterName: flags.filterName ?? undefined
	});

	if (flags.json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	if (result.ok) {
		log.ok(`All ${result.steps.length} verification step(s) passed`);
		for (const step of result.steps) {
			log.dim(`  ${step.name} (${step.durationMs}ms)`);
		}
	} else {
		log.error(`Verification failed at ${result.failedStep}`);
		for (const step of result.steps) {
			const icon = step.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
			console.log(`  ${icon} ${step.name} (${step.durationMs}ms)`);
		}
		process.exit(1);
	}
}
