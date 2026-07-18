import * as z from 'zod/mini'
import { safeJson } from '../fetch.js'
import { mapboxAccuracy } from '../map/accuracy.js'
import { err, ok } from '../result.js'
import type {
	AddressComponents,
	AddressQuery,
	Coords,
	GeoResult,
	Place,
} from '../types.js'
import type {
	ApiKeyOptions,
	BatchProvider,
	ProviderRequestOpts,
} from './types.js'

const featureSchema = z.object({
	type: z.optional(z.string()),
	id: z.optional(z.string()),
	geometry: z.optional(
		z.object({
			type: z.optional(z.string()),
			coordinates: z.optional(z.array(z.number())),
		}),
	),
	properties: z.optional(
		z.object({
			mapbox_id: z.optional(z.string()),
			feature_type: z.optional(z.string()),
			name: z.optional(z.string()),
			name_preferred: z.optional(z.string()),
			place_formatted: z.optional(z.string()),
			full_address: z.optional(z.string()),
			coordinates: z.optional(
				z.object({
					longitude: z.optional(z.number()),
					latitude: z.optional(z.number()),
					accuracy: z.optional(z.string()),
				}),
			),
			context: z.optional(z.record(z.string(), z.unknown())),
			address: z.optional(z.string()),
		}),
	),
})

const collectionSchema = z.object({
	type: z.optional(z.string()),
	features: z.optional(z.array(featureSchema)),
})

const batchSchema = z.object({
	batch: z.optional(z.array(collectionSchema)),
})

type Feature = z.infer<typeof featureSchema>

function ctxField(
	ctx: Record<string, unknown> | undefined,
	key: string,
	field: string,
): string | undefined {
	const v = ctx?.[key]
	if (!v || typeof v !== 'object') return undefined
	const val = (v as Record<string, unknown>)[field]
	return typeof val === 'string' ? val : undefined
}

const STREETISH = new Set(['address', 'street', 'secondary_address'])

function featureToPlace(f: Feature): Place | null {
	const p = f.properties
	const geo = f.geometry?.coordinates
	const lng = geo?.[0]
	const lat = geo?.[1]
	const coords =
		p?.coordinates?.latitude != null && p?.coordinates?.longitude != null
			? { lat: p.coordinates.latitude, lng: p.coordinates.longitude }
			: typeof lat === 'number' && typeof lng === 'number'
				? { lat, lng }
				: null
	if (!coords) return null

	const ctx =
		p?.context && typeof p.context === 'object'
			? (p.context as Record<string, unknown>)
			: undefined
	const featureType = p?.feature_type
	const label = p?.name_preferred ?? p?.name
	const components: AddressComponents = {
		streetNumber:
			ctxField(ctx, 'address', 'address_number') ??
			(typeof p?.address === 'string' ? p.address : undefined),
		street:
			ctxField(ctx, 'street', 'name') ??
			ctxField(ctx, 'address', 'street_name'),
		unit: featureType === 'secondary_address' ? label : undefined,
		locality:
			ctxField(ctx, 'place', 'name') ?? ctxField(ctx, 'locality', 'name'),
		neighborhood: ctxField(ctx, 'neighborhood', 'name'),
		county: ctxField(ctx, 'district', 'name'),
		region: ctxField(ctx, 'region', 'name'),
		postcode: ctxField(ctx, 'postcode', 'name'),
		country: ctxField(ctx, 'country', 'name'),
		countryCode: ctxField(ctx, 'country', 'country_code')?.toUpperCase(),
	}

	const formatted =
		p?.full_address ??
		[label, p?.place_formatted].filter(Boolean).join(', ') ??
		`${coords.lat},${coords.lng}`

	return {
		formatted: formatted || `${coords.lat},${coords.lng}`,
		coordinates: coords,
		components,
		accuracy: mapboxAccuracy(p?.coordinates?.accuracy),
		provider: 'mapbox',
		id: p?.mapbox_id ?? f.id,
		name: featureType && !STREETISH.has(featureType) ? label : undefined,
	}
}

function parseCollection(json: unknown): GeoResult<Place> {
	const parsed = z.safeParse(collectionSchema, json)
	if (!parsed.success) {
		return err({
			code: 'BAD_RESPONSE',
			message: 'Invalid Mapbox response',
			provider: 'mapbox',
		})
	}
	const feature = parsed.data.features?.[0]
	if (!feature)
		return err({ code: 'NOT_FOUND', message: 'No results', provider: 'mapbox' })
	const place = featureToPlace(feature)
	if (!place)
		return err({
			code: 'BAD_RESPONSE',
			message: 'Missing coordinates',
			provider: 'mapbox',
		})
	return ok(place)
}

function structuredParams(q: Exclude<AddressQuery, string>): URLSearchParams {
	const p = new URLSearchParams()
	if (q.streetNumber) p.set('address_number', q.streetNumber)
	if (q.street) p.set('street', q.street)
	if (q.street2) p.set('address_line2', q.street2)
	if (q.locality) p.set('place', q.locality)
	if (q.region) p.set('region', q.region)
	if (q.postcode) p.set('postcode', q.postcode)
	if (q.country) p.set('country', q.country)
	return p
}

function forwardBody(
	q: AddressQuery,
	opts?: ProviderRequestOpts,
): Record<string, unknown> {
	const base: Record<string, unknown> = { types: 'address', limit: 1 }
	if (opts?.country) base.country = opts.country.toLowerCase()
	if (opts?.language) base.language = opts.language
	if (typeof q === 'string') {
		return { ...base, q }
	}
	return {
		...base,
		...(q.streetNumber ? { address_number: q.streetNumber } : {}),
		...(q.street ? { street: q.street } : {}),
		...(q.street2 ? { address_line2: q.street2 } : {}),
		...(q.locality ? { place: q.locality } : {}),
		...(q.region ? { region: q.region } : {}),
		...(q.postcode ? { postcode: q.postcode } : {}),
		...(q.country ? { country: q.country } : {}),
	}
}

export type MapboxOptions = ApiKeyOptions

export function mapbox({ apiKey }: MapboxOptions): BatchProvider {
	async function geocode(
		query: AddressQuery,
		opts?: ProviderRequestOpts,
	): Promise<GeoResult<Place>> {
		const url = new URL('https://api.mapbox.com/search/geocode/v6/forward')
		url.searchParams.set('access_token', apiKey)
		url.searchParams.set('limit', '1')
		if (opts?.country)
			url.searchParams.set('country', opts.country.toLowerCase())
		if (opts?.language) url.searchParams.set('language', opts.language)
		if (typeof query === 'string') {
			url.searchParams.set('q', query)
		} else {
			for (const [k, v] of structuredParams(query)) url.searchParams.set(k, v)
		}
		const json = await safeJson(url, {
			provider: 'mapbox',
			signal: opts?.signal,
			timeoutMs: opts?.timeoutMs,
		})
		if (json.error) return json
		return parseCollection(json.data)
	}

	async function reverseGeocode(
		coords: Coords,
		opts?: ProviderRequestOpts,
	): Promise<GeoResult<Place>> {
		const url = new URL('https://api.mapbox.com/search/geocode/v6/reverse')
		url.searchParams.set('access_token', apiKey)
		url.searchParams.set('longitude', String(coords.lng))
		url.searchParams.set('latitude', String(coords.lat))
		url.searchParams.set('limit', '1')
		if (opts?.country)
			url.searchParams.set('country', opts.country.toLowerCase())
		if (opts?.language) url.searchParams.set('language', opts.language)
		const json = await safeJson(url, {
			provider: 'mapbox',
			signal: opts?.signal,
			timeoutMs: opts?.timeoutMs,
		})
		if (json.error) return json
		return parseCollection(json.data)
	}

	async function geocodeBatch(
		queries: AddressQuery[],
		opts?: ProviderRequestOpts,
	): Promise<GeoResult<Place>[]> {
		const json = await safeJson(
			'https://api.mapbox.com/search/geocode/v6/batch?access_token=' +
				encodeURIComponent(apiKey),
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(queries.map((q) => forwardBody(q, opts))),
				provider: 'mapbox',
				signal: opts?.signal,
				timeoutMs: opts?.timeoutMs,
			},
		)
		if (json.error) return queries.map(() => json)
		const parsed = z.safeParse(batchSchema, json.data)
		if (!parsed.success) {
			const e = err({
				code: 'BAD_RESPONSE',
				message: 'Invalid Mapbox batch response',
				provider: 'mapbox',
			})
			return queries.map(() => e)
		}
		const batch = parsed.data.batch ?? []
		return queries.map((_, i) => parseCollection(batch[i] ?? { features: [] }))
	}

	async function reverseGeocodeBatch(
		coordsList: Coords[],
		opts?: ProviderRequestOpts,
	): Promise<GeoResult<Place>[]> {
		const body = coordsList.map((c) => ({
			longitude: c.lng,
			latitude: c.lat,
			limit: 1,
			...(opts?.country ? { country: opts.country.toLowerCase() } : {}),
			...(opts?.language ? { language: opts.language } : {}),
		}))
		const json = await safeJson(
			'https://api.mapbox.com/search/geocode/v6/batch?access_token=' +
				encodeURIComponent(apiKey),
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				provider: 'mapbox',
				signal: opts?.signal,
				timeoutMs: opts?.timeoutMs,
			},
		)
		if (json.error) return coordsList.map(() => json)
		const parsed = z.safeParse(batchSchema, json.data)
		if (!parsed.success) {
			const e = err({
				code: 'BAD_RESPONSE',
				message: 'Invalid Mapbox batch response',
				provider: 'mapbox',
			})
			return coordsList.map(() => e)
		}
		const batch = parsed.data.batch ?? []
		return coordsList.map((_, i) =>
			parseCollection(batch[i] ?? { features: [] }),
		)
	}

	return {
		name: 'mapbox',
		defaultRateLimit: { maxPerMinute: 1000 },
		geocode,
		reverseGeocode,
		geocodeBatch,
		reverseGeocodeBatch,
	}
}
