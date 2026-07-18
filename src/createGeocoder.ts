import type { BatchProvider, Provider } from './providers/types.js'
import { createRateLimiter, mapPool } from './rate-limit.js'
import { isEmptyQuery, isValidCoords, refinePlace } from './refine.js'
import { err } from './result.js'
import type {
	Accuracy,
	AddressQuery,
	Coords,
	GeoError,
	GeoResult,
	LookupOpts,
	LookupOptsBase,
	Place,
	PlaceNarrowed,
	RequireKey,
} from './types.js'

export type ProvidersSupportBatch<Ps extends readonly Provider[]> =
	Extract<Ps[number], BatchProvider> extends never ? false : true

export type ArrayModeFor<Ps extends readonly Provider[]> =
	ProvidersSupportBatch<Ps> extends true
		? 'auto' | 'batch' | 'sequential'
		: 'auto' | 'sequential'

export type LookupOptsFor<
	Ps extends readonly Provider[],
	R extends RequireKey = never,
	A extends Accuracy = Accuracy,
> = Omit<LookupOpts<R, A>, 'mode'> & { mode?: ArrayModeFor<Ps> }

export type WithAddressOptsFor<
	Ps extends readonly Provider[],
	T,
	R extends RequireKey = never,
	A extends Accuracy = Accuracy,
> = LookupOptsFor<Ps, R, A> & {
	getCoords?: (item: T) => Coords
}

export type CreateGeocoderOptions<
	Ps extends readonly [Provider, ...Provider[]] = readonly [
		Provider,
		...Provider[],
	],
> = {
	providers: Ps
	shouldFallback?: (error: GeoError) => boolean
}

function defaultShouldFallback(e: GeoError) {
	return e.code !== 'BAD_REQUEST' && e.code !== 'ABORTED'
}

function requestOpts(opts?: LookupOptsBase) {
	return {
		country: opts?.country,
		language: opts?.language,
		signal: opts?.signal,
		timeoutMs: opts?.timeoutMs,
		permanent: opts?.permanent,
	}
}

function refineOpts(opts?: LookupOptsBase) {
	return {
		minAccuracy: opts?.minAccuracy,
		require: opts?.require,
	}
}

async function withFallback(
	providers: readonly Provider[],
	shouldFallback: (e: GeoError) => boolean,
	run: (p: Provider) => Promise<GeoResult<Place>>,
	filter: ReturnType<typeof refineOpts>,
): Promise<GeoResult<Place>> {
	if (!providers.length) {
		return err({ code: 'BAD_REQUEST', message: 'No providers configured' })
	}
	let last: GeoResult<Place> = err({
		code: 'BAD_REQUEST',
		message: 'No providers configured',
	})
	for (let i = 0; i < providers.length; i++) {
		const p = providers[i]
		if (!p) continue
		const raw = await run(p)
		const result = !raw.error ? refinePlace(raw.data, filter, p.name) : raw
		last = result
		if (!result.error) return result
		const more = i < providers.length - 1 && shouldFallback(result.error)
		if (!more) return result
	}
	return last
}

async function runArray<T>(
	items: T[],
	providers: readonly Provider[],
	shouldFallback: (e: GeoError) => boolean,
	opts: LookupOptsBase | undefined,
	hasBatch: (p: Provider) => boolean,
	batchFn: (p: Provider, items: T[]) => Promise<GeoResult<Place>[]>,
	oneFn: (p: Provider, item: T) => Promise<GeoResult<Place>>,
): Promise<GeoResult<Place>[]> {
	const mode = opts?.mode ?? 'auto'
	const filter = refineOpts(opts)
	const first = providers[0]
	const useBatch =
		mode === 'batch' || (mode === 'auto' && first && hasBatch(first))

	if (useBatch && first && hasBatch(first)) {
		const batch = await batchFn(first, items)
		const out: GeoResult<Place>[] = []
		for (let i = 0; i < items.length; i++) {
			const item = items[i]
			const raw =
				batch[i] ??
				err({ code: 'NOT_FOUND', message: 'No results', provider: first.name })
			let result: GeoResult<Place> = !raw.error
				? refinePlace(raw.data, filter, first.name)
				: raw
			if (
				item !== undefined &&
				result.error &&
				shouldFallback(result.error) &&
				providers.length > 1
			) {
				result = await withFallback(
					providers.slice(1),
					shouldFallback,
					(p) => oneFn(p, item),
					filter,
				)
			}
			out.push(result)
		}
		return out
	}

	// sequential / paced (also fallback when batch unsupported)
	const limit = opts?.rateLimit ??
		first?.defaultRateLimit ?? { maxPerMinute: 60 }
	const pace = createRateLimiter(limit)
	const concurrency = Math.max(1, opts?.concurrency ?? 1)
	return mapPool(items, concurrency, pace, (item) =>
		withFallback(providers, shouldFallback, (p) => oneFn(p, item), filter),
	)
}

export function createGeocoder<const Ps extends readonly unknown[]>(config: {
	providers: Ps & readonly [Provider, ...Provider[]]
	shouldFallback?: (error: GeoError) => boolean
}) {
	const providers = config.providers
	const shouldFallback = config.shouldFallback ?? defaultShouldFallback

	type Provs = Ps & readonly [Provider, ...Provider[]]

	async function geocode<
		R extends RequireKey = never,
		A extends Accuracy = Accuracy,
	>(
		query: AddressQuery,
		opts?: LookupOptsFor<Provs, R, A>,
	): Promise<GeoResult<PlaceNarrowed<R, A>>>
	async function geocode<
		R extends RequireKey = never,
		A extends Accuracy = Accuracy,
	>(
		query: AddressQuery[],
		opts?: LookupOptsFor<Provs, R, A>,
	): Promise<GeoResult<PlaceNarrowed<R, A>>[]>
	async function geocode(
		query: AddressQuery | AddressQuery[],
		opts?: LookupOptsFor<Provs, RequireKey, Accuracy>,
	): Promise<GeoResult<Place> | GeoResult<Place>[]> {
		if (Array.isArray(query)) {
			return runArray(
				query,
				providers,
				shouldFallback,
				opts,
				(p) => typeof p.geocodeBatch === 'function',
				(p, items) => {
					const batch = p.geocodeBatch
					if (!batch) {
						return Promise.resolve(
							items.map(() =>
								err({
									code: 'BAD_REQUEST',
									message: 'Provider does not support batch geocode',
									provider: p.name,
								}),
							),
						)
					}
					return batch(items, requestOpts(opts))
				},
				(p, q) => {
					if (isEmptyQuery(q)) {
						return Promise.resolve(
							err({ code: 'BAD_REQUEST', message: 'Empty geocode query' }),
						)
					}
					return p.geocode(q, requestOpts(opts))
				},
			)
		}
		if (isEmptyQuery(query)) {
			return err({ code: 'BAD_REQUEST', message: 'Empty geocode query' })
		}
		return withFallback(
			providers,
			shouldFallback,
			(p) => p.geocode(query, requestOpts(opts)),
			refineOpts(opts),
		)
	}

	async function reverseGeocode<
		R extends RequireKey = never,
		A extends Accuracy = Accuracy,
	>(
		coords: Coords,
		opts?: LookupOptsFor<Provs, R, A>,
	): Promise<GeoResult<PlaceNarrowed<R, A>>>
	async function reverseGeocode<
		R extends RequireKey = never,
		A extends Accuracy = Accuracy,
	>(
		coords: Coords[],
		opts?: LookupOptsFor<Provs, R, A>,
	): Promise<GeoResult<PlaceNarrowed<R, A>>[]>
	async function reverseGeocode(
		coords: Coords | Coords[],
		opts?: LookupOptsFor<Provs, RequireKey, Accuracy>,
	): Promise<GeoResult<Place> | GeoResult<Place>[]> {
		if (Array.isArray(coords)) {
			return runArray(
				coords,
				providers,
				shouldFallback,
				opts,
				(p) => typeof p.reverseGeocodeBatch === 'function',
				(p, items) => {
					const batch = p.reverseGeocodeBatch
					if (!batch) {
						return Promise.resolve(
							items.map(() =>
								err({
									code: 'BAD_REQUEST',
									message: 'Provider does not support batch reverse geocode',
									provider: p.name,
								}),
							),
						)
					}
					return batch(items, requestOpts(opts))
				},
				(p, c) => {
					if (!isValidCoords(c)) {
						return Promise.resolve(
							err({ code: 'BAD_REQUEST', message: 'Invalid coordinates' }),
						)
					}
					return p.reverseGeocode(c, requestOpts(opts))
				},
			)
		}
		if (!isValidCoords(coords)) {
			return err({ code: 'BAD_REQUEST', message: 'Invalid coordinates' })
		}
		return withFallback(
			providers,
			shouldFallback,
			(p) => p.reverseGeocode(coords, requestOpts(opts)),
			refineOpts(opts),
		)
	}

	async function withAddress<
		T extends Coords,
		R extends RequireKey = never,
		A extends Accuracy = Accuracy,
	>(
		item: T,
		opts?: WithAddressOptsFor<Provs, T, R, A>,
	): Promise<T & { address: GeoResult<PlaceNarrowed<R, A>> }>
	async function withAddress<
		T extends object,
		R extends RequireKey = never,
		A extends Accuracy = Accuracy,
	>(
		item: T,
		opts: WithAddressOptsFor<Provs, T, R, A> & {
			getCoords: (item: T) => Coords
		},
	): Promise<T & { address: GeoResult<PlaceNarrowed<R, A>> }>
	async function withAddress<
		T extends Coords,
		R extends RequireKey = never,
		A extends Accuracy = Accuracy,
	>(
		items: T[],
		opts?: WithAddressOptsFor<Provs, T, R, A>,
	): Promise<Array<T & { address: GeoResult<PlaceNarrowed<R, A>> }>>
	async function withAddress<
		T extends object,
		R extends RequireKey = never,
		A extends Accuracy = Accuracy,
	>(
		items: T[],
		opts: WithAddressOptsFor<Provs, T, R, A> & {
			getCoords: (item: T) => Coords
		},
	): Promise<Array<T & { address: GeoResult<PlaceNarrowed<R, A>> }>>
	async function withAddress(
		itemOrItems: unknown,
		opts?: WithAddressOptsFor<Provs, object, RequireKey, Accuracy>,
	): Promise<
		| (object & { address: GeoResult<Place> })
		| Array<object & { address: GeoResult<Place> }>
	> {
		const getCoords = opts?.getCoords ?? ((x: object) => x as unknown as Coords)

		if (Array.isArray(itemOrItems)) {
			const items = itemOrItems as object[]
			const coords = items.map((item) => {
				try {
					return getCoords(item)
				} catch {
					return null
				}
			})
			const results = await reverseGeocode(
				coords.map((c) => (c && isValidCoords(c) ? c : { lat: NaN, lng: NaN })),
				opts,
			)
			return items.map((item, i) => {
				const c = coords[i]
				const address =
					c && isValidCoords(c)
						? (results[i] ??
							err({ code: 'BAD_REQUEST', message: 'Invalid coordinates' }))
						: err({ code: 'BAD_REQUEST', message: 'Invalid coordinates' })
				return { ...item, address }
			})
		}

		const item = itemOrItems as object
		let coords: Coords
		try {
			coords = getCoords(item)
		} catch {
			return {
				...item,
				address: err({ code: 'BAD_REQUEST', message: 'Invalid coordinates' }),
			}
		}
		const address = await reverseGeocode(coords, opts)
		return { ...item, address }
	}

	return { geocode, reverseGeocode, withAddress }
}

export type Geocoder<
	Ps extends readonly [Provider, ...Provider[]] = readonly [
		Provider,
		...Provider[],
	],
> = ReturnType<typeof createGeocoder<Ps>>
