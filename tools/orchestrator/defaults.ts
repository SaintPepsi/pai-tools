/**
 * Default configuration values for the orchestrator.
 * Per-project overrides live in `.pai/orchestrator.json`.
 */

import type { OrchestratorConfig } from './types.ts';

export const ORCHESTRATOR_DEFAULTS: OrchestratorConfig = {
	branchPrefix: 'feat/',
	baseBranch: 'master',
	worktreeDir: '.pait/worktrees',
	models: {
		implement: 'sonnet',
		assess: 'haiku'
	},
	retries: {
		implement: 1,
		verify: 1
	},
	allowedTools: 'Bash Edit Write Read Glob Grep',
	verify: []
};
