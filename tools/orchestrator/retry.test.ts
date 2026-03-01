import { describe, test, expect } from 'bun:test';
import { withRetries } from './retry.ts';

describe('withRetries', () => {
	test('returns ok:true with value on first success', async () => {
		const fn = async () => ({ ok: true as const, data: 'result' });
		const fixer = async (_attempt: number) => {};
		const result = await withRetries(fn, fixer, 3);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.data).toBe('result');
		}
	});

	test('returns ok:false when all attempts fail', async () => {
		const fn = async () => ({ ok: false as const });
		const fixer = async (_attempt: number) => {};
		const result = await withRetries(fn, fixer, 3);
		expect(result.ok).toBe(false);
	});

	test('calls fixer between failed attempts', async () => {
		const fixerCalls: number[] = [];
		let callCount = 0;
		const fn = async () => {
			callCount++;
			return callCount >= 3 ? { ok: true as const } : { ok: false as const };
		};
		const fixer = async (attempt: number) => { fixerCalls.push(attempt); };
		const result = await withRetries(fn, fixer, 5);
		expect(result.ok).toBe(true);
		expect(fixerCalls).toEqual([0, 1]);
	});

	test('does not call fixer after last failed attempt', async () => {
		const fixerCalls: number[] = [];
		const fn = async () => ({ ok: false as const });
		const fixer = async (attempt: number) => { fixerCalls.push(attempt); };
		await withRetries(fn, fixer, 3);
		// With 3 attempts (0,1,2), fixer should be called after attempt 0 and 1 — not after 2
		expect(fixerCalls).toEqual([0, 1]);
	});

	test('succeeds on second attempt after one failure', async () => {
		let callCount = 0;
		const fn = async () => {
			callCount++;
			return callCount === 2 ? { ok: true as const } : { ok: false as const };
		};
		const fixerCalls: number[] = [];
		const fixer = async (attempt: number) => { fixerCalls.push(attempt); };
		const result = await withRetries(fn, fixer, 3);
		expect(result.ok).toBe(true);
		expect(fixerCalls).toEqual([0]);
	});

	test('returns ok:false with maxAttempts of 1 when fn fails', async () => {
		const fn = async () => ({ ok: false as const });
		const fixerCalls: number[] = [];
		const fixer = async (attempt: number) => { fixerCalls.push(attempt); };
		const result = await withRetries(fn, fixer, 1);
		expect(result.ok).toBe(false);
		// With only 1 attempt, fixer is never called (no retry possible)
		expect(fixerCalls).toEqual([]);
	});

	test('returns ok:true immediately with maxAttempts of 1 when fn succeeds', async () => {
		const fn = async () => ({ ok: true as const, value: 42 });
		const fixer = async (_attempt: number) => {};
		const result = await withRetries(fn, fixer, 1);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.value).toBe(42);
		}
	});

	test('result value contains the full object returned by fn', async () => {
		const fn = async () => ({ ok: true as const, code: 200, body: 'hello' });
		const fixer = async (_attempt: number) => {};
		const result = await withRetries(fn, fixer, 2);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.code).toBe(200);
			expect(result.value.body).toBe('hello');
		}
	});

	test('fixer receives correct attempt numbers in sequence', async () => {
		const fixerAttempts: number[] = [];
		const fn = async () => ({ ok: false as const });
		const fixer = async (attempt: number) => { fixerAttempts.push(attempt); };
		await withRetries(fn, fixer, 4);
		expect(fixerAttempts).toEqual([0, 1, 2]);
	});

	test('returns ok:false immediately when maxAttempts is 0', async () => {
		let callCount = 0;
		const fn = async () => { callCount++; return { ok: true as const }; };
		const fixer = async (_attempt: number) => {};
		const result = await withRetries(fn, fixer, 0);
		expect(result.ok).toBe(false);
		expect(callCount).toBe(0);
	});
});
