import { describe, test, expect } from 'bun:test';
import { promptLine, type PromptDeps } from './prompt.ts';

function makeRlDeps(answer: string): PromptDeps & { closed: boolean; lastQuestion: string } {
	let closed = false;
	let lastQuestion = '';
	const rl = {
		question: (q: string, cb: (ans: string) => void) => {
			lastQuestion = q;
			cb(answer);
		},
		close: () => { closed = true; },
	};
	const deps: PromptDeps & { closed: boolean; lastQuestion: string } = {
		createRl: () => rl,
		stdin: {} as NodeJS.ReadableStream,
		stdout: {} as NodeJS.WritableStream,
		get closed() { return closed; },
		get lastQuestion() { return lastQuestion; },
	};
	return deps;
}

describe('promptLine', () => {
	test('resolves with trimmed answer', async () => {
		const deps = makeRlDeps('  hello world  ');
		const result = await promptLine('Enter value: ', deps);
		expect(result).toBe('hello world');
	});

	test('passes question string to rl.question', async () => {
		const deps = makeRlDeps('yes');
		await promptLine('Are you sure? ', deps);
		expect(deps.lastQuestion).toBe('Are you sure? ');
	});

	test('closes readline interface after answer', async () => {
		const deps = makeRlDeps('ok');
		await promptLine('Confirm: ', deps);
		expect(deps.closed).toBe(true);
	});

	test('resolves empty string when answer is whitespace only', async () => {
		const deps = makeRlDeps('   ');
		const result = await promptLine('Enter: ', deps);
		expect(result).toBe('');
	});

	test('resolves with answer that contains internal spaces', async () => {
		const deps = makeRlDeps('foo bar baz');
		const result = await promptLine('Name: ', deps);
		expect(result).toBe('foo bar baz');
	});

	test('createRl is called with stdin and stdout from deps', async () => {
		const fakeStdin = {} as NodeJS.ReadableStream;
		const fakeStdout = {} as NodeJS.WritableStream;
		let capturedOpts: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } | null = null;

		const deps: PromptDeps = {
			createRl: (opts) => {
				capturedOpts = opts;
				return {
					question: (_q, cb) => cb('answer'),
					close: () => {},
				};
			},
			stdin: fakeStdin,
			stdout: fakeStdout,
		};

		await promptLine('Q: ', deps);
		expect(capturedOpts).not.toBeNull();
		expect(capturedOpts!.input).toBe(fakeStdin);
		expect(capturedOpts!.output).toBe(fakeStdout);
	});
});
