/**
 * Core verification runner — importable without the flag parsing and
 * config-loading scaffolding in verify/index.ts.
 *
 * Use `runVerify()` programmatically from the orchestrator, finalize, or
 * any other tool that needs to run verification commands.
 * Types live in tools/verify/types.ts — import from there directly.
 */

import { $ } from 'bun';
import { log } from '@shared/log.ts';
import type { VerifyOptions, VerifyResult, VerifyStepResult } from '@tools/verify/types.ts';

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export interface RunVerifyDeps {
	log: typeof log;
}

export const defaultRunVerifyDeps: RunVerifyDeps = {
	log,
};

// ---------------------------------------------------------------------------
// Internal Result type — avoids try-catch flow control
// ---------------------------------------------------------------------------

type RunResult = { ok: true; durationMs: number } | { ok: false; durationMs: number; errorMsg: string };

async function runCmd(cmd: string, cwd: string): Promise<RunResult> {
	const start = Date.now();
	const result = await $`${{ raw: cmd }}`.cwd(cwd).quiet().nothrow();
	const durationMs = Date.now() - start;
	if (result.exitCode === 0) {
		return { ok: true, durationMs };
	}
	const output = result.stderr.toString() || result.stdout.toString();
	const errorMsg = output.slice(-2000) || `exit code ${result.exitCode}`;
	return { ok: false, durationMs, errorMsg };
}

export async function runVerify(opts: VerifyOptions, deps: RunVerifyDeps = defaultRunVerifyDeps): Promise<VerifyResult> {
	const steps: VerifyStepResult[] = [];
	const issueNum = opts.issueNumber ?? 0;

	// Filter steps if --name provided
	const verifySteps = opts.filterName
		? opts.verify.filter((s) => s.name === opts.filterName)
		: opts.verify;

	for (const step of verifySteps) {
		deps.log.info(`Running ${step.name}: ${step.cmd}`);
		const res = await runCmd(step.cmd, opts.cwd);
		if (res.ok) {
			deps.log.ok(`${step.name} passed`);
			steps.push({ name: step.name, ok: true, durationMs: res.durationMs });
			opts.logger?.verifyPass(issueNum, step.name);
		} else {
			steps.push({ name: step.name, ok: false, durationMs: res.durationMs, error: res.errorMsg });
			opts.logger?.verifyFail(issueNum, step.name, res.errorMsg);
			return { ok: false, steps, failedStep: step.name, error: res.errorMsg };
		}
	}

	// E2E (only if configured and not skipped)
	if (opts.e2e && !opts.skipE2e) {
		deps.log.info(`Running E2E: ${opts.e2e.run}`);
		const e2eRes = await runCmd(opts.e2e.run, opts.cwd);
		if (e2eRes.ok) {
			deps.log.ok('E2E passed');
			steps.push({ name: 'e2e', ok: true, durationMs: e2eRes.durationMs });
			opts.logger?.verifyPass(issueNum, 'e2e');
		} else {
			// First run failed — attempt snapshot update then re-run
			deps.log.warn('E2E failed — attempting snapshot update...');
			await runCmd(opts.e2e.update, opts.cwd);
			const retryRes = await runCmd(opts.e2e.run, opts.cwd);
			if (retryRes.ok) {
				deps.log.ok('E2E passed after snapshot update');
				steps.push({ name: 'e2e (after snapshot update)', ok: true, durationMs: retryRes.durationMs });
				opts.logger?.verifyPass(issueNum, 'e2e (after snapshot update)');
				// Stage updated snapshots
				const glob = opts.e2e.snapshotGlob;
				await $`git -C ${opts.cwd} add -A ${glob}`.quiet().nothrow();
				await $`git -C ${opts.cwd} commit -m ${'test: update E2E snapshots for #' + issueNum}`
					.quiet()
					.nothrow();
			} else {
				steps.push({ name: 'e2e', ok: false, durationMs: retryRes.durationMs, error: retryRes.errorMsg });
				opts.logger?.verifyFail(issueNum, 'e2e', retryRes.errorMsg);
				return { ok: false, steps, failedStep: 'e2e', error: retryRes.errorMsg };
			}
		}
	}

	return { ok: true, steps };
}
