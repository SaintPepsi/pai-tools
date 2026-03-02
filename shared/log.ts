/**
 * Colored terminal logging utilities.
 */

export interface LogDeps {
	log: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
	stdout: { write: (s: string) => void };
}

export const defaultLogDeps: LogDeps = {
	log: (...args) => console.log(...args),
	error: (...args) => console.error(...args),
	stdout: process.stdout,
};

export function makeLog(deps: LogDeps = defaultLogDeps) {
	return {
		info: (msg: string) => deps.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
		ok: (msg: string) => deps.log(`\x1b[32m[OK]\x1b[0m ${msg}`),
		warn: (msg: string) => deps.log(`\x1b[33m[WARN]\x1b[0m ${msg}`),
		error: (msg: string) => deps.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
		step: (msg: string) => deps.log(`\n\x1b[35m━━━ ${msg} ━━━\x1b[0m`),
		dim: (msg: string) => deps.log(`\x1b[2m${msg}\x1b[0m`),
	};
}

export const log = makeLog();

/**
 * Animated terminal spinner for long-running operations.
 */
export class Spinner {
	private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
	private frameIndex = 0;
	private interval: ReturnType<typeof setInterval> | null = null;
	private startTime = 0;
	private message = '';
	private deps: LogDeps;

	constructor(deps: LogDeps = defaultLogDeps) {
		this.deps = deps;
	}

	start(message: string): void {
		this.message = message;
		this.startTime = Date.now();
		this.frameIndex = 0;
		this.interval = setInterval(() => {
			const elapsed = Math.round((Date.now() - this.startTime) / 1000);
			const frame = this.frames[this.frameIndex % this.frames.length];
			this.deps.stdout.write(`\r\x1b[36m${frame}\x1b[0m ${this.message} \x1b[2m(${elapsed}s)\x1b[0m\x1b[K`);
			this.frameIndex++;
		}, 80);
	}

	stop(finalMessage?: string): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
		this.deps.stdout.write('\r\x1b[K');
		if (finalMessage) {
			this.deps.log(finalMessage);
		}
	}
}
