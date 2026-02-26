/**
 * Shared verify-fixer logic for the orchestrator.
 *
 * Invokes a Claude agent to fix verification failures, used by both the
 * sequential execution loop (execution.ts via agent-runner.ts) and the
 * parallel scheduler (parallel.ts).
 */

import { Spinner } from '../../shared/log.ts';
import { runClaude } from '../../shared/claude.ts';
import type { RunLogger } from '../../shared/logging.ts';
import type { OrchestratorConfig } from './types.ts';

export interface FixVerificationOptions {
	issueNumber: number;
	failedStep: string;
	errorOutput: string;
	config: OrchestratorConfig;
	worktreePath: string;
	logger: RunLogger;
	/** Optional spinner label override (e.g. "[#5] Agent fixing verification"). */
	spinnerLabel?: string;
}

/**
 * Invokes the Claude agent to fix a verification failure.
 *
 * Builds a targeted fix prompt from the failed step and error output, runs the
 * agent inside the issue worktree, and logs the agent output. Returns without
 * throwing — callers rely on the subsequent verify retry to detect success.
 */
export async function fixVerificationFailure(opts: FixVerificationOptions): Promise<void> {
	const { issueNumber, failedStep, errorOutput, config, worktreePath, logger, spinnerLabel } = opts;

	const verifyList = config.verify.map((v) => `- ${v.cmd}`).join('\n');
	const fixPrompt = `The verification step "${failedStep}" failed for issue #${issueNumber}.

Error output:
${errorOutput}

Please fix the issues and ensure all verification commands pass:
${verifyList}

Commit your fixes referencing #${issueNumber}.`;

	const label = spinnerLabel ?? `Agent fixing verification for #${issueNumber}`;
	const spinner = new Spinner();
	spinner.start(label);

	const fixResult = await runClaude({
		prompt: fixPrompt,
		model: config.models.implement,
		cwd: worktreePath,
		permissionMode: 'acceptEdits',
		allowedTools: config.allowedTools
	}).catch(() => ({ ok: false, output: '' }));

	spinner.stop();
	logger.agentOutput(issueNumber, fixResult.output);
}
