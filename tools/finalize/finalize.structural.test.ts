import { describe, test, expect, beforeAll } from 'bun:test';
import { join } from 'node:path';

let source: string;
let gitSource: string;

beforeAll(async () => {
	source = await Bun.file(join(import.meta.dir, 'index.ts')).text();
	gitSource = await Bun.file(join(import.meta.dir, '../../shared/git.ts')).text();
});

describe('finalize source: merge success path clears error (regression)', () => {
	test('source code clears error on successful merge (regression)', () => {
		// The merge success path must set prState.error = null.
		// Matches the pattern: status = 'merged' followed by error = null.
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
		// After DI refactor, args are in array form: 'rebase', '--continue'
		const continueLines = gitSource.split('\n').filter(
			(line) => line.includes('rebase --continue') || (line.includes("'--continue'") && line.includes('rebase'))
		);
		expect(continueLines.length).toBeGreaterThanOrEqual(2);
		// GIT_EDITOR is passed via editorEnv variable near rebase --continue calls
		const editorLines = gitSource.split('\n').filter(
			(line) => line.includes('GIT_EDITOR')
		);
		expect(editorLines.length).toBeGreaterThanOrEqual(2);
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
		// Conflict resolution functions live in shared/git.ts after extraction.
		const templatePathPattern = /(?:readFileSync|writeFileSync|readFile|writeFile)\(`\$\{repoRoot\}\/\$\{c\.file\}`/;
		expect(gitSource).not.toMatch(templatePathPattern);
	});

	test('promptLine is not defined locally — uses shared module', () => {
		// Regression: promptLine was duplicated in verify and finalize.
		// After extraction, promptLine is used in shared/git.ts.
		expect(source).not.toContain('function promptLine');
		expect(gitSource).toContain("from './prompt.ts'");
	});
});

describe('shared promptLine module', () => {
	test('promptLine defined exactly once in shared/prompt.ts', async () => {
		const sharedSource = await Bun.file(
			join(import.meta.dir, '../../shared/prompt.ts')
		).text();
		expect(sharedSource).toContain('export function promptLine');

		// verify/index.ts no longer uses promptLine (moved to orchestrator/prompt.ts)
		const verifySource = await Bun.file(
			join(import.meta.dir, '../verify/index.ts')
		).text();
		expect(verifySource).not.toContain('function promptLine');
		// verify/index.ts must not import shared/prompt.ts after refactor
		expect(verifySource).not.toContain("from '../../shared/prompt.ts'");

		// promptForVerifyCommands now lives in orchestrator/prompt.ts and imports from shared
		const orchestratorPromptSource = await Bun.file(
			join(import.meta.dir, '../orchestrator/prompt.ts')
		).text();
		expect(orchestratorPromptSource).not.toContain('function promptLine');
		expect(orchestratorPromptSource).toContain("from '../../shared/prompt.ts'");
	});
});
