/**
 * Shared git infrastructure helpers.
 *
 * Branch operations, worktree management, and conflict resolution
 * used by both the orchestrator and finalize tools.
 */

import { $ } from 'bun';
import { join, resolve } from 'node:path';
import { log, RollingWindow } from 'shared/log.ts';
import { promptLine } from 'shared/prompt.ts';
import { runClaude } from 'shared/claude.ts';
import type { RunClaudeOpts } from 'shared/claude.ts';
import type { RunLogger } from 'shared/logging.ts';
import {
	readFile as _readFile,
	writeFile as _writeFile,
	fileExists as _fileExists,
	removeDir as _removeDir,
} from 'shared/fs.ts';

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

/**
 * Injectable dependencies for git conflict resolution operations.
 * Separates I/O and env concerns from business logic for testability.
 */
export interface GitDeps {
	readFile: (path: string) => Promise<string>;
	writeFile: (path: string, content: string) => Promise<void>;
	fileExists: (path: string) => Promise<boolean>;
	removeDir: (path: string) => Promise<void>;
	env: Record<string, string | undefined>;
	makeWindow: (header: string, logPath: string) => RollingWindow;
	claude: (opts: RunClaudeOpts) => Promise<{ ok: boolean; output: string }>;
}

const defaultGitDeps: GitDeps = {
	readFile: _readFile,
	writeFile: _writeFile,
	fileExists: _fileExists,
	removeDir: _removeDir,
	env: Bun.env,
	makeWindow: (header, logPath) => new RollingWindow({ header, logPath }),
	claude: runClaude,
};

// ---------------------------------------------------------------------------
// Branch operations
// ---------------------------------------------------------------------------

export async function localBranchExists(name: string, repoRoot: string): Promise<boolean> {
	const result = await $`git -C ${repoRoot} rev-parse --verify refs/heads/${name}`.quiet().nothrow();
	return result.exitCode === 0;
}

export async function deleteLocalBranch(name: string, repoRoot: string): Promise<void> {
	if (await localBranchExists(name, repoRoot)) {
		await $`git -C ${repoRoot} branch -D ${name}`.quiet().nothrow();
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
	issueNumber: number,
	deps: GitDeps = defaultGitDeps
): Promise<{ ok: boolean; worktreePath: string; baseBranch: string; error?: string }> {
	const worktreeDir = resolve(repoRoot, config.worktreeDir);
	const slug = branchName.replace(/\//g, '-');
	const worktreePath = join(worktreeDir, slug);

	// Clean up any leftover worktree from a previous run
	await $`git -C ${repoRoot} worktree remove --force ${worktreePath}`.quiet().nothrow();
	if (await deps.fileExists(worktreePath)) {
		await deps.removeDir(worktreePath);
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

	// Create worktree with a new branch based on the chosen base
	const addResult = await $`git -C ${repoRoot} worktree add -b ${branchName} ${worktreePath} ${baseBranch}`.quiet().nothrow();
	if (addResult.exitCode !== 0) {
		return { ok: false, worktreePath, baseBranch, error: `Failed to create worktree for ${branchName}` };
	}

	logger.worktreeCreated(issueNumber, worktreePath, branchName);
	logger.branchCreated(issueNumber, branchName, baseBranch);

	// Merge additional dependency branches inside the worktree
	for (let i = 1; i < existingDeps.length; i++) {
		const mergeResult = await $`git -C ${worktreePath} merge ${existingDeps[i]} --no-edit -m ${'Merge dependency branch ' + existingDeps[i]}`.quiet().nothrow();
		if (mergeResult.exitCode !== 0) {
			await $`git -C ${worktreePath} merge --abort`.quiet().nothrow();
			await removeWorktree(worktreePath, branchName, repoRoot, logger, issueNumber, deps);
			return {
				ok: false,
				worktreePath,
				baseBranch,
				error: `Merge conflict merging ${existingDeps[i]} into ${branchName} (based on ${baseBranch})`
			};
		}
	}

	return { ok: true, worktreePath, baseBranch };
}

export async function removeWorktree(
	worktreePath: string,
	branchName: string,
	repoRoot: string,
	logger: RunLogger,
	issueNumber: number,
	deps: GitDeps = defaultGitDeps
): Promise<void> {
	const removeResult = await $`git -C ${repoRoot} worktree remove --force ${worktreePath}`.quiet().nothrow();
	if (removeResult.exitCode !== 0) {
		// Force-remove the directory if git worktree remove fails
		if (await deps.fileExists(worktreePath)) {
			await deps.removeDir(worktreePath);
		}
		// Prune stale worktree entries
		await $`git -C ${repoRoot} worktree prune`.quiet().nothrow();
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
	const checkoutResult = await $`git -C ${repoRoot} checkout ${branch}`.quiet().nothrow();
	if (checkoutResult.exitCode !== 0) {
		return { ok: false };
	}

	const rebaseResult = await $`git -C ${repoRoot} rebase ${onto}`.quiet().nothrow();
	if (rebaseResult.exitCode !== 0) {
		const conflicts = await detectConflicts(repoRoot);
		if (conflicts.length > 0) {
			return { ok: false, conflicts };
		}
		// Abort failed rebase that isn't a conflict
		await $`git -C ${repoRoot} rebase --abort`.quiet().nothrow();
		return { ok: false };
	}

	return { ok: true };
}

export async function detectConflicts(repoRoot: string): Promise<ConflictInfo[]> {
	const result = await $`git -C ${repoRoot} diff --name-only --diff-filter=U`.quiet().nothrow();
	if (result.exitCode !== 0) return [];
	const output = result.text().trim();
	if (!output) return [];
	return output.split('\n').map((file) => ({ file }));
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
	repoRoot: string,
	deps: GitDeps = defaultGitDeps
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
			const conflictContent = await deps.readFile(join(repoRoot, c.file));
			const prompt = `You are resolving a git merge conflict in the file "${c.file}".

The user's intent for resolving this conflict is: "${intent}"

Here is the file with conflict markers:

${conflictContent}

Output ONLY the resolved file content. No explanation, no code fences, just the file content.`;

			const window = deps.makeWindow(`Resolving conflict: ${c.file}`, '');
			const result = await deps.claude({
				prompt,
				model: 'sonnet',
				cwd: repoRoot,
				onChunk: (chunk) => window.update(chunk),
			});
			window.clear();

			if (result.ok && result.output.trim()) {
				const validated = validateResolvedContent(result.output, c.file);
				if (!validated) {
					log.error(`Resolution validation failed for ${c.file}`);
					return false;
				}
				await deps.writeFile(join(repoRoot, c.file), validated);
				await $`git -C ${repoRoot} add ${c.file}`.quiet();
			} else {
				log.error(`Failed to resolve ${c.file} via Claude`);
				return false;
			}
		}
	}

	// Continue rebase (GIT_EDITOR=true prevents editor from opening in non-interactive context)
	const continueResult = await $`git -C ${repoRoot} rebase --continue`
		.env({ ...deps.env, GIT_EDITOR: 'true' })
		.quiet()
		.nothrow();
	if (continueResult.exitCode !== 0) {
		log.error('Rebase continue failed after conflict resolution');
		await $`git -C ${repoRoot} rebase --abort`.quiet().nothrow();
		return false;
	}
	return true;
}

/**
 * Sanitize and validate Claude's conflict resolution output before writing.
 * Returns the cleaned content, or null if the output is invalid.
 */
function validateResolvedContent(raw: string, filePath: string): string | null {
	let content = raw;

	// Strip markdown code fences if Claude wrapped the output
	const fenceMatch = content.match(/^```[\w]*\n([\s\S]*?)\n```\s*$/);
	if (fenceMatch) {
		content = fenceMatch[1];
	}

	// Reject if conflict markers are still present (unresolved)
	if (/^<{7}\s|^={7}$|^>{7}\s/m.test(content)) {
		log.error(`Resolved content for ${filePath} still contains conflict markers`);
		return null;
	}

	// For code files, reject output that is clearly prose explanation instead of code
	const codeExtensions = ['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.html', '.sh', '.yaml', '.yml', '.toml'];
	const isCodeFile = codeExtensions.some((ext) => filePath.endsWith(ext));

	if (isCodeFile) {
		const firstLine = content.trim().split('\n')[0].trim();
		const prosePatterns = [
			/^(The |Here |I |This |Let me |Below |Above |Note |Sure |Okay |Ok )/i,
			/^(To resolve|The conflict|I've |I have |The resolved|The result)/i,
			/^\*\*/  // markdown bold (e.g. **Conflict 1**)
		];
		if (prosePatterns.some((p) => p.test(firstLine))) {
			log.error(`Resolved content for ${filePath} appears to be prose, not code: "${firstLine.slice(0, 60)}..."`);
			return null;
		}
	}

	return content;
}

export async function autoResolveConflicts(
	conflicts: ConflictInfo[],
	repoRoot: string,
	deps: GitDeps = defaultGitDeps
): Promise<boolean> {
	for (const c of conflicts) {
		const conflictContent = await deps.readFile(join(repoRoot, c.file));
		const prompt = `You are resolving a git merge conflict in the file "${c.file}".

Resolve this conflict by keeping both changes where possible. If the changes are incompatible, prefer the incoming (feature branch) version marked with >>>>>>> but integrate any non-conflicting parts from the current branch marked with <<<<<<<.

Here is the file with conflict markers:

${conflictContent}

Output ONLY the resolved file content. No explanation, no code fences, just the file content.`;

		const window = deps.makeWindow(`Auto-resolving conflict: ${c.file}`, '');
		const result = await deps.claude({
			prompt,
			model: 'sonnet',
			cwd: repoRoot,
			onChunk: (chunk) => window.update(chunk),
		});
		window.clear();

		if (!result.ok || !result.output.trim()) {
			log.error(`Failed to auto-resolve ${c.file}`);
			return false;
		}

		const validated = validateResolvedContent(result.output, c.file);
		if (!validated) {
			log.error(`Auto-resolve validation failed for ${c.file} — aborting`);
			return false;
		}

		await deps.writeFile(join(repoRoot, c.file), validated);
		await $`git -C ${repoRoot} add ${c.file}`.quiet();
		log.ok(`Auto-resolved: ${c.file}`);
	}

	// Continue rebase (GIT_EDITOR=true prevents editor from opening in non-interactive context)
	const continueResult = await $`git -C ${repoRoot} rebase --continue`
		.env({ ...deps.env, GIT_EDITOR: 'true' })
		.quiet()
		.nothrow();
	if (continueResult.exitCode !== 0) {
		log.error('Rebase continue failed after auto-resolution');
		await $`git -C ${repoRoot} rebase --abort`.quiet().nothrow();
		return false;
	}
	return true;
}
