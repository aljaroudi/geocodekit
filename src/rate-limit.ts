import type { RateLimit } from './types.js'

/** Token-bucket style limiter from maxPerMinute. */
export function createRateLimiter(limit: RateLimit) {
	const intervalMs = 60_000 / Math.max(1, limit.maxPerMinute)
	let next = 0

	return async function pace(): Promise<void> {
		const now = Date.now()
		const wait = Math.max(0, next - now)
		next = Math.max(now, next) + intervalMs
		if (wait > 0) await new Promise((r) => setTimeout(r, wait))
	}
}

/** Run tasks with concurrency cap + optional per-call pace. */
export async function mapPool<T, R>(
	items: T[],
	concurrency: number,
	pace: (() => Promise<void>) | undefined,
	fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
	const out = new Array<R>(items.length)
	let i = 0
	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) || 1 },
		async () => {
			while (i < items.length) {
				const idx = i++
				const item = items[idx]
				if (item === undefined) continue
				if (pace) await pace()
				out[idx] = await fn(item, idx)
			}
		},
	)
	await Promise.all(workers)
	return out
}
