import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { $ } from 'bun';
import { RunLogger } from './logging.ts';

describe('RunLogger — prCreated', () => {
	test('logs pr_created event with issueNumber and prNumber', async () => {
		const tmpDir = (await $`mktemp -d`.text()).trim();
		const logger = new RunLogger(tmpDir);
		logger.prCreated(5, 42);

		const content = await Bun.file(logger.path).text();
		const event = JSON.parse(content.trim());
		expect(event.event).toBe('pr_created');
		expect(event.issueNumber).toBe(5);
		expect(event.prNumber).toBe(42);
		expect(event.timestamp).toBeTruthy();

		await $`rm -rf ${tmpDir}`.quiet();
	});
});
