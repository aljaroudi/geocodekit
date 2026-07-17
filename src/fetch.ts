import { err, ok } from './result.js'
import type { GeoErrorCode, GeoResult, ProviderName } from './types.js'

export type SafeFetchInit = RequestInit & {
	timeoutMs?: number
	provider?: ProviderName
}

function mapAbort(
	signal: AbortSignal | undefined,
	provider?: ProviderName,
): GeoResult<never> {
	if (
		signal?.reason instanceof DOMException &&
		signal.reason.name === 'TimeoutError'
	) {
		return err({ code: 'TIMEOUT', message: 'Request timed out', provider })
	}
	return err({ code: 'ABORTED', message: 'Request aborted', provider })
}

function httpCode(status: number): GeoErrorCode {
	if (status === 401 || status === 403) return 'AUTH'
	if (status === 429) return 'RATE_LIMIT'
	if (status >= 500) return 'PROVIDER_DOWN'
	if (status >= 400) return 'BAD_REQUEST'
	return 'NETWORK'
}

/** fetch that never throws — network/HTTP/abort → GeoResult. */
export async function safeFetch(
	url: string | URL,
	init: SafeFetchInit = {},
): Promise<GeoResult<Response>> {
	const { timeoutMs, provider, signal: userSignal, ...rest } = init
	const ac = new AbortController()
	const onAbort = () =>
		ac.abort(userSignal?.reason ?? new DOMException('Aborted', 'AbortError'))
	if (userSignal) {
		if (userSignal.aborted) return mapAbort(userSignal, provider)
		userSignal.addEventListener('abort', onAbort, { once: true })
	}
	let timer: ReturnType<typeof setTimeout> | undefined
	if (timeoutMs != null && timeoutMs > 0) {
		timer = setTimeout(
			() => ac.abort(new DOMException('Timeout', 'TimeoutError')),
			timeoutMs,
		)
	}
	try {
		const res = await fetch(url, { ...rest, signal: ac.signal })
		if (!res.ok) {
			return err({
				code: httpCode(res.status),
				message: `HTTP ${res.status}`,
				provider,
				status: res.status,
			})
		}
		return ok(res)
	} catch (e) {
		if (ac.signal.aborted) return mapAbort(ac.signal, provider)
		return err({
			code: 'NETWORK',
			message: e instanceof Error ? e.message : 'Network error',
			provider,
		})
	} finally {
		if (timer) clearTimeout(timer)
		userSignal?.removeEventListener('abort', onAbort)
	}
}

export async function safeJson(
	url: string | URL,
	init: SafeFetchInit = {},
): Promise<GeoResult<unknown>> {
	const res = await safeFetch(url, init)
	if (res.error) return res
	try {
		return ok(await res.data.json())
	} catch (e) {
		return err({
			code: 'BAD_RESPONSE',
			message: e instanceof Error ? e.message : 'Invalid JSON',
			provider: init.provider,
		})
	}
}
