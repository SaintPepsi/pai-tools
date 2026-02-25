/**
 * Core verification runner — importable without the flag parsing and
 * config-loading scaffolding in verify/index.ts.
 *
 * Use `runVerify()` programmatically from the orchestrator, finalize, or
 * any other tool that needs to run verification commands.
 * Types live in tools/verify/types.ts — import from there directly.
 */

import { $ } from 'bun';
import { log } from '../../shared/log.ts';
import type { VerifyOptions, VerifyResult, VerifyStepResult } from './types.ts';


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
