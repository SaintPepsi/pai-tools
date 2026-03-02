import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { $ } from 'bun';
import { defaultFsAdapter } from './fs.ts';

describe('defaultFsAdapter — real filesystem operations', () => {
	test('readFile reads a file', async () => {
		const tmpDir = (await $`mktemp -d`.text()).trim();
		const path = join(tmpDir, 'test.txt');
		await Bun.write(path, 'hello');

		expect(defaultFsAdapter.readFile(path)).toBe('hello');
		await $`rm -rf ${tmpDir}`.quiet();
	});

	test('writeFile writes a file', async () => {
		const tmpDir = (await $`mktemp -d`.text()).trim();
		const path = join(tmpDir, 'out.txt');

		defaultFsAdapter.writeFile(path, 'world');

		const content = await Bun.file(path).text();
		expect(content).toBe('world');
		await $`rm -rf ${tmpDir}`.quiet();
	});

	test('appendFile appends to a file', async () => {
		const tmpDir = (await $`mktemp -d`.text()).trim();
		const path = join(tmpDir, 'append.txt');
		await Bun.write(path, 'a');

		defaultFsAdapter.appendFile(path, 'b');

		const content = await Bun.file(path).text();
		expect(content).toBe('ab');
		await $`rm -rf ${tmpDir}`.quiet();
	});

	test('unlinkFile deletes a file', async () => {
		const tmpDir = (await $`mktemp -d`.text()).trim();
		const path = join(tmpDir, 'del.txt');
		await Bun.write(path, 'x');

		defaultFsAdapter.unlinkFile(path);

		const exists = await Bun.file(path).exists();
		expect(exists).toBe(false);
		await $`rm -rf ${tmpDir}`.quiet();
	});

	test('fileExists returns true for existing, false for missing', async () => {
		const tmpDir = (await $`mktemp -d`.text()).trim();
		const path = join(tmpDir, 'exists.txt');
		await Bun.write(path, 'y');

		expect(defaultFsAdapter.fileExists(path)).toBe(true);
		expect(defaultFsAdapter.fileExists(join(tmpDir, 'nope.txt'))).toBe(false);
		await $`rm -rf ${tmpDir}`.quiet();
	});

	test('mkdirp creates nested directories', async () => {
		const tmpDir = (await $`mktemp -d`.text()).trim();
		const nested = join(tmpDir, 'a', 'b', 'c');

		defaultFsAdapter.mkdirp(nested);

		const exists = await Bun.file(join(nested, '..')).exists();
		// Check by writing a file inside
		await Bun.write(join(nested, 'test.txt'), 'ok');
		const content = await Bun.file(join(nested, 'test.txt')).text();
		expect(content).toBe('ok');
		await $`rm -rf ${tmpDir}`.quiet();
	});

	test('copyFile copies a file', async () => {
		const tmpDir = (await $`mktemp -d`.text()).trim();
		const src = join(tmpDir, 'src.txt');
		const dest = join(tmpDir, 'dest.txt');
		await Bun.write(src, 'copy me');

		defaultFsAdapter.copyFile(src, dest);

		const content = await Bun.file(dest).text();
		expect(content).toBe('copy me');
		await $`rm -rf ${tmpDir}`.quiet();
	});

	test('rmrf removes a directory tree', async () => {
		const tmpDir = (await $`mktemp -d`.text()).trim();
		const nested = join(tmpDir, 'target', 'deep');
		await $`mkdir -p ${nested}`.quiet();
		await Bun.write(join(nested, 'file.txt'), 'data');

		defaultFsAdapter.rmrf(join(tmpDir, 'target'));

		const exists = await Bun.file(join(tmpDir, 'target')).exists();
		expect(exists).toBe(false);
		await $`rm -rf ${tmpDir}`.quiet();
	});

	test('parseJson returns parsed object for valid JSON', () => {
		expect(defaultFsAdapter.parseJson('{"a":1}')).toEqual({ a: 1 });
	});

	test('parseJson returns null for invalid JSON', () => {
		expect(defaultFsAdapter.parseJson('not-json')).toBeNull();
	});
});
