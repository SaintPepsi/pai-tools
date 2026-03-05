import { describe, test, expect, beforeAll } from 'bun:test';
import { join } from 'node:path';

const projectRoot = join(import.meta.dir, '..', '..');

let source = '';
let gitSource = '';
let sharedSource = '';
let verifySource = '';
let orchestratorPromptSource = '';

beforeAll(async () => {
	source = await Bun.file(join(import.meta.dir, 'index.ts')).text();
	gitSource = await Bun.file(join(projectRoot, 'shared', 'git.ts')).text();
	sharedSource = await Bun.file(join(projectRoot, 'shared', 'prompt.ts')).text();
	verifySource = await Bun.file(join(projectRoot, 'tools', 'verify', 'index.ts')).text();
	orchestratorPromptSource = await Bun.file(join(projectRoot, 'tools', 'orchestrator', 'prompt.ts')).text();
});

describe('finalize source: merge success path clears error (regression)', () => {
	test('source code clears error on successful merge (regression)', () => {
		const mergedIdx = source.indexOf("prState.status = 'merged'");
		const nextStatusIdx = source.indexOf("prState.status =", mergedIdx + 1);
		const mergedBlock = source.slice(mergedIdx, nextStatusIdx === -1 ? mergedIdx + 400 : nextStatusIdx);
		expect(mergedBlock).toContain('prState.error = null');
	});
});

describe('finalize source guards (regression)', () => {
	test('no startIdx guard — all PRs get rebased', () => {
		// Regression: `if (i > startIdx)` skipped rebase for first PR.
		expect(source).not.toContain('i > startIdx');
	});

	test('rebase --continue sets GIT_EDITOR to prevent editor hang', () => {
		// Regression: bare `rebase --continue` could open an editor in
		// non-interactive contexts, hanging the process indefinitely.
		// GIT_EDITOR may appear on an adjacent line in a chained call.
		const lines = gitSource.split('\n');
		const continueIndices = lines
			.map((line, i) => (line.includes('rebase --continue') ? i : -1))
			.filter((i) => i !== -1);

		expect(continueIndices.length).toBeGreaterThanOrEqual(2);
		for (const idx of continueIndices) {
			// Check the line itself and the next 3 lines for GIT_EDITOR
			const context = lines.slice(idx, idx + 4).join('\n');
			expect(context).toContain('GIT_EDITOR');
		}
	});

	test('force push catch logs a warning instead of silent swallow', () => {
		// Regression: .catch(() => {}) on force-with-lease silently swallowed
		// failures, causing opaque downstream merge errors.
		const pushLine = source.split('\n').find(
			(line) => line.includes('force-with-lease')
		);
		expect(pushLine).toBeDefined();
		// Must NOT be an empty catch
		expect(pushLine).not.toMatch(/\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/);
	});

	test('conflict file paths use join() not template concatenation', () => {
		// Regression: `${repoRoot}/${c.file}` is fragile; join() is correct.
		const templatePathPattern = /(?:readFileSync|writeFileSync)\(`\$\{repoRoot\}\/\$\{c\.file\}`/;
		expect(gitSource).not.toMatch(templatePathPattern);
	});

	test('promptLine is not defined locally — uses shared module', () => {
		// Regression: promptLine was duplicated in verify and finalize.
		// After extraction, promptLine is imported in shared/git.ts via path alias.
		expect(source).not.toContain('function promptLine');
		expect(gitSource).toContain("from 'shared/prompt.ts'");
	});
});

describe('shared promptLine module', () => {
	test('promptLine defined exactly once in shared/prompt.ts', () => {
		expect(sharedSource).toContain('export function promptLine');

		// verify/index.ts no longer uses promptLine (moved to orchestrator/prompt.ts)
		expect(verifySource).not.toContain('function promptLine');
		// verify/index.ts must not import shared/prompt.ts after refactor
		expect(verifySource).not.toMatch(/from ['"].*shared\/prompt\.ts['"]/);

		// promptForVerifyCommands now lives in orchestrator/prompt.ts and imports from shared
		expect(orchestratorPromptSource).not.toContain('function promptLine');
		expect(orchestratorPromptSource).toMatch(/from ['"].*shared\/prompt\.ts['"]/);
	});
});
