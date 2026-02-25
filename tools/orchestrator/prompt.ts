/**
 * Interactive config collection for the orchestrator's onboarding flow.
 *
 * Prompts the user to configure verification commands when none are set.
 */

import { log } from '../../shared/log.ts';
import { promptLine } from '../../shared/prompt.ts';
import type { VerifyCommand } from '../verify/types.ts';

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
