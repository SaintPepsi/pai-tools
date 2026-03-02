/**
 * Standalone verification tool — CLI entry point and flag parsing.
 *
 * Core verification engine: `tools/verify/runner.ts`
 * Interactive config prompt: `tools/orchestrator/prompt.ts`
 */

import { log } from '../../shared/log.ts';
import { findRepoRoot, loadToolConfig } from '../../shared/config.ts';
import { runVerify } from './runner.ts';
import type {
	VerifyCommand,
	VerifyFlags,
	VerifyOptions,
	VerifyResult,
	VerifyStepResult
} from './types.ts';

// Re-export types and runner for convenience
export type { VerifyCommand, VerifyFlags, VerifyOptions, VerifyResult, VerifyStepResult } from './types.ts';
export { runVerify } from './runner.ts';

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

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export interface VerifyDeps {
	log: (...args: unknown[]) => void;
	exit: (code: number) => never;
	findRepoRoot: () => string;
	loadToolConfig: <T>(repoRoot: string, toolName: string, defaults: T) => T;
	runVerify: (opts: VerifyOptions) => Promise<VerifyResult>;
}

export const defaultVerifyDeps: VerifyDeps = {
	log: console.log,
	exit: process.exit as (code: number) => never,
	findRepoRoot,
	loadToolConfig,
	runVerify,
};

export async function verify(flags: VerifyFlags, deps: VerifyDeps = defaultVerifyDeps): Promise<void> {
	if (flags.help) {
		deps.log(VERIFY_HELP);
		return;
	}

	const repoRoot = deps.findRepoRoot();
	const config = deps.loadToolConfig<OrchestratorConfigPartial>(repoRoot, 'orchestrator', {
		verify: [],
	});

	if (config.verify.length === 0 && !config.e2e) {
		log.error('No verification commands configured in .pait/orchestrator.json');
		log.info('Run `pait orchestrate` first to configure verification steps.');
		deps.exit(1);
	}

	const result = await deps.runVerify({
		verify: config.verify,
		e2e: config.e2e,
		cwd: repoRoot,
		skipE2e: flags.skipE2e,
		filterName: flags.filterName ?? undefined
	});

	if (flags.json) {
		deps.log(JSON.stringify(result, null, 2));
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
			deps.log(`  ${icon} ${step.name} (${step.durationMs}ms)`);
		}
		deps.exit(1);
	}
}
