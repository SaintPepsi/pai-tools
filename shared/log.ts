/**
 * Colored terminal logging utilities.
 */

export const log = {
	info: (msg: string) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
	ok: (msg: string) => console.log(`\x1b[32m[OK]\x1b[0m ${msg}`),
	warn: (msg: string) => console.log(`\x1b[33m[WARN]\x1b[0m ${msg}`),
	error: (msg: string) => console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
	step: (msg: string) => console.log(`\n\x1b[35m━━━ ${msg} ━━━\x1b[0m`),
	dim: (msg: string) => console.log(`\x1b[2m${msg}\x1b[0m`)
};

/**
 * Animated terminal spinner for long-running operations.
 */
export class Spinner {
	private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
	private frameIndex = 0;
	private interval: ReturnType<typeof setInterval> | null = null;
	private startTime = 0;
	private message = '';

	start(message: string): void {
		this.message = message;
		this.startTime = Date.now();
		this.frameIndex = 0;
		this.interval = setInterval(() => {
			const elapsed = Math.round((Date.now() - this.startTime) / 1000);
			const frame = this.frames[this.frameIndex % this.frames.length];
			process.stdout.write(`\r\x1b[36m${frame}\x1b[0m ${this.message} \x1b[2m(${elapsed}s)\x1b[0m\x1b[K`);
			this.frameIndex++;
		}, 80);
	}

	stop(finalMessage?: string): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
		process.stdout.write('\r\x1b[K');
		if (finalMessage) {
			console.log(finalMessage);
		}
	}
}
