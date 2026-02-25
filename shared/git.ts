/**
 * Shared git infrastructure helpers.
 *
 * Branch operations, worktree management, and conflict resolution
 * used by both the orchestrator and finalize tools.
 */

import { $ } from 'bun';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { log } from './log.ts';
import { promptLine } from './prompt.ts';
import { runClaude } from './claude.ts';
import type { RunLogger } from './logging.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal config required for worktree operations. */
export interface WorktreeConfig {
	worktreeDir: string;
	baseBranch: string;
}

export interface ConflictInfo {
	file: string;
}

// ---------------------------------------------------------------------------
// Branch operations
// ---------------------------------------------------------------------------

export async function localBranchExists(name: string, repoRoot: string): Promise<boolean> {
	try {
		await $`git -C ${repoRoot} rev-parse --verify refs/heads/${name}`.quiet();
		return true;
	} catch {
		return false;
	}
}

export async function deleteLocalBranch(name: string, repoRoot: string): Promise<void> {
	if (await localBranchExists(name, repoRoot)) {
		await $`git -C ${repoRoot} branch -D ${name}`.quiet().catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// Worktree operations
// ---------------------------------------------------------------------------

export async function createWorktree(
	branchName: string,
	depBranches: string[],
	config: WorktreeConfig,
	repoRoot: string,
	logger: RunLogger,
	issueNumber: number
): Promise<{ ok: boolean; worktreePath: string; baseBranch: string; error?: string }> {
	const worktreeDir = resolve(repoRoot, config.worktreeDir);
	const slug = branchName.replace(/\//g, '-');
	const worktreePath = join(worktreeDir, slug);

	// Clean up any leftover worktree from a previous run
	try {
		await $`git -C ${repoRoot} worktree remove --force ${worktreePath}`.quiet();
	} catch {
		// Not an existing worktree — that's fine
	}
	if (existsSync(worktreePath)) {
		rmSync(worktreePath, { recursive: true, force: true });
	}

	// Delete stale local branch if it exists
	await deleteLocalBranch(branchName, repoRoot);

	// Determine base branch from dependencies
	const existingDeps: string[] = [];
	for (const dep of depBranches) {
		if (await localBranchExists(dep, repoRoot)) {
			existingDeps.push(dep);
		}
	}
	const baseBranch = existingDeps.length > 0 ? existingDeps[0] : config.baseBranch;

	try {
		// Create worktree with a new branch based on the chosen base
		await $`git -C ${repoRoot} worktree add -b ${branchName} ${worktreePath} ${baseBranch}`.quiet();

		logger.worktreeCreated(issueNumber, worktreePath, branchName);
		logger.branchCreated(issueNumber, branchName, baseBranch);

		// Merge additional dependency branches inside the worktree
		for (let i = 1; i < existingDeps.length; i++) {
			try {
				await $`git -C ${worktreePath} merge ${existingDeps[i]} --no-edit -m ${'Merge dependency branch ' + existingDeps[i]}`.quiet();
			} catch {
				await $`git -C ${worktreePath} merge --abort`.quiet().catch(() => {});
				await removeWorktree(worktreePath, branchName, repoRoot, logger, issueNumber);
				return {
					ok: false,
					worktreePath,
					baseBranch,
					error: `Merge conflict merging ${existingDeps[i]} into ${branchName} (based on ${baseBranch})`
				};
			}
		}

		return { ok: true, worktreePath, baseBranch };
	} catch (err) {
		return { ok: false, worktreePath, baseBranch, error: `Failed to create worktree for ${branchName}: ${err}` };
	}
}

export async function removeWorktree(
	worktreePath: string,
	branchName: string,
	repoRoot: string,
	logger: RunLogger,
	issueNumber: number
): Promise<void> {
	try {
		await $`git -C ${repoRoot} worktree remove --force ${worktreePath}`.quiet();
	} catch {
		// Force-remove the directory if git worktree remove fails
		if (existsSync(worktreePath)) {
			rmSync(worktreePath, { recursive: true, force: true });
		}
		// Prune stale worktree entries
		await $`git -C ${repoRoot} worktree prune`.quiet().catch(() => {});
	}
	logger.worktreeRemoved(issueNumber, worktreePath);
}

// ---------------------------------------------------------------------------
// Rebase operations
// ---------------------------------------------------------------------------

export async function rebaseBranch(
	branch: string,
	onto: string,
	repoRoot: string
): Promise<{ ok: boolean; conflicts?: ConflictInfo[] }> {
	try {
		await $`git -C ${repoRoot} checkout ${branch}`.quiet();
		await $`git -C ${repoRoot} rebase ${onto}`.quiet();
		return { ok: true };
	} catch {
		// Check for conflict
		const conflicts = await detectConflicts(repoRoot);
		if (conflicts.length > 0) {
			return { ok: false, conflicts };
		}
		// Abort failed rebase that isn't a conflict
		await $`git -C ${repoRoot} rebase --abort`.quiet().catch(() => {});
		return { ok: false };
	}
}

export async function detectConflicts(repoRoot: string): Promise<ConflictInfo[]> {
	try {
		const output = (
			await $`git -C ${repoRoot} diff --name-only --diff-filter=U`.text()
		).trim();
		if (!output) return [];
		return output.split('\n').map((file) => ({ file }));
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

export async function presentConflicts(
	conflicts: ConflictInfo[]
): Promise<Map<string, string>> {
	const intents = new Map<string, string>();

	log.warn(`${conflicts.length} file(s) have conflicts:`);
	for (const c of conflicts) {
		console.log(`  - ${c.file}`);
	}
	console.log('');

	for (const c of conflicts) {
		log.info(`Conflict in: ${c.file}`);
		const answer = await promptLine(
			'  Resolution (ours/theirs/describe intent): '
		);
		intents.set(c.file, answer.trim() || 'ours');
	}

	return intents;
}

export async function resolveConflicts(
	conflicts: ConflictInfo[],
	intents: Map<string, string>,
	repoRoot: string
): Promise<boolean> {
	for (const c of conflicts) {
		const intent = intents.get(c.file) ?? 'ours';

		if (intent === 'ours') {
			await $`git -C ${repoRoot} checkout --ours ${c.file}`.quiet();
			await $`git -C ${repoRoot} add ${c.file}`.quiet();
		} else if (intent === 'theirs') {
			await $`git -C ${repoRoot} checkout --theirs ${c.file}`.quiet();
			await $`git -C ${repoRoot} add ${c.file}`.quiet();
		} else {
			// Custom intent: use Claude to resolve
			const conflictContent = readFileSync(join(repoRoot, c.file), 'utf-8');
			const prompt = `You are resolving a git merge conflict in the file "${c.file}".

The user's intent for resolving this conflict is: "${intent}"

Here is the file with conflict markers:

${conflictContent}

Output ONLY the resolved file content. No explanation, no code fences, just the file content.`;

			const result = await runClaude({
				prompt,
				model: 'sonnet',
				cwd: repoRoot
			});

			if (result.ok && result.output.trim()) {
				writeFileSync(join(repoRoot, c.file), result.output);
				await $`git -C ${repoRoot} add ${c.file}`.quiet();
			} else {
				log.error(`Failed to resolve ${c.file} via Claude`);
				return false;
			}
		}
	}

	// Continue rebase (GIT_EDITOR=true prevents editor from opening in non-interactive context)
	try {
		await $`git -C ${repoRoot} rebase --continue`.env({ ...process.env, GIT_EDITOR: 'true' }).quiet();
		return true;
	} catch {
		log.error('Rebase continue failed after conflict resolution');
		await $`git -C ${repoRoot} rebase --abort`.quiet().catch(() => {});
		return false;
	}
}

export async function autoResolveConflicts(
	conflicts: ConflictInfo[],
	repoRoot: string
): Promise<boolean> {
	for (const c of conflicts) {
		const conflictContent = readFileSync(join(repoRoot, c.file), 'utf-8');
		const prompt = `You are resolving a git merge conflict in the file "${c.file}".

Resolve this conflict by keeping both changes where possible. If the changes are incompatible, prefer the incoming (feature branch) version marked with >>>>>>> but integrate any non-conflicting parts from the current branch marked with <<<<<<<.

Here is the file with conflict markers:

${conflictContent}

Output ONLY the resolved file content. No explanation, no code fences, just the file content.`;

		const result = await runClaude({
			prompt,
			model: 'sonnet',
			cwd: repoRoot
		});

		if (result.ok && result.output.trim()) {
			writeFileSync(join(repoRoot, c.file), result.output);
			await $`git -C ${repoRoot} add ${c.file}`.quiet();
			log.ok(`Auto-resolved: ${c.file}`);
		} else {
			log.error(`Failed to auto-resolve ${c.file}`);
			return false;
		}
	}

	// Continue rebase (GIT_EDITOR=true prevents editor from opening in non-interactive context)
	try {
		await $`git -C ${repoRoot} rebase --continue`.env({ ...process.env, GIT_EDITOR: 'true' }).quiet();
		return true;
	} catch {
		log.error('Rebase continue failed after auto-resolution');
		await $`git -C ${repoRoot} rebase --abort`.quiet().catch(() => {});
		return false;
	}
}
