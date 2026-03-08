import { createInterface } from 'node:readline';

export interface PromptDeps {
	createRl: (opts: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }) => {
		question: (q: string, cb: (ans: string) => void) => void;
		close: () => void;
	};
	stdin: NodeJS.ReadableStream;
	stdout: NodeJS.WritableStream;
}

export const defaultPromptDeps: PromptDeps = {
	createRl: createInterface,
	stdin: process.stdin,
	stdout: process.stdout,
};

export function promptLine(question: string, deps: PromptDeps = defaultPromptDeps): Promise<string> {
	const rl = deps.createRl({ input: deps.stdin, output: deps.stdout });
	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}
