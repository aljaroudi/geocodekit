import * as z from 'zod/mini'
import { safeJson } from '../fetch.js'
import { geocodAccuracy } from '../map/accuracy.js'
import { err, ok } from '../result.js'
import type {
	AddressComponents,
	AddressQuery,
	Coords,
	GeoResult,
	Place,
	SearchOpts,
} from '../types.js'
import type {
	ApiKeyOptions,
	BatchProvider,
	ProviderRequestOpts,
	SearchProvider,
} from './types.js'

const addressComponentsSchema = z.object({
	number: z.optional(z.string()),
	street: z.optional(z.string()),
	formatted_street: z.optional(z.string()),
	street2: z.optional(z.string()),
	addressee: z.optional(z.string()),
	city: z.optional(z.string()),
	county: z.optional(z.string()),
	state: z.optional(z.string()),
	state_province: z.optional(z.string()),
	postal_code: z.optional(z.string()),
	country: z.optional(z.string()),
})

const resultSchema = z.object({
	formatted_address: z.optional(z.string()),
	accuracy: z.optional(z.nullable(z.number())),
	accuracy_type: z.optional(z.nullable(z.string())),
	addressee: z.optional(z.string()),
	stable_address_key: z.optional(z.string()),
	address_components: z.optional(addressComponentsSchema),
	location: z.optional(
		z.object({
			lat: z.number(),
			lng: z.number(),
		}),
	),
})

const singleSchema = z.object({
	results: z.optional(z.array(resultSchema)),
	error: z.optional(z.string()),
})

const batchSchema = z.object({
	results: z.optional(
		z.array(
			z.object({
				query: z.optional(z.unknown()),
				response: z.optional(singleSchema),
			}),
		),
	),
	error: z.optional(z.string()),
})

function toPlace(r: z.infer<typeof resultSchema>): Place | null {
	const loc = r.location
	if (!loc) return null
	const ac = r.address_components
	const components: AddressComponents = {
		streetNumber: ac?.number,
		street: ac?.formatted_street ?? ac?.street,
		unit: ac?.street2,
		locality: ac?.city,
		county: ac?.county,
		region: ac?.state_province ?? ac?.state,
		postcode: ac?.postal_code,
		country: ac?.country,
		countryCode:
			ac?.country?.length === 2 ? ac.country.toUpperCase() : undefined,
	}
	const name = r.addressee ?? ac?.addressee
	return {
		formatted: r.formatted_address ?? `${loc.lat},${loc.lng}`,
		coordinates: { lat: loc.lat, lng: loc.lng },
		components,
		accuracy: geocodAccuracy(r.accuracy_type ?? undefined),
		provider: 'geocod',
		id: r.stable_address_key,
		name,
	}
}

function parseSingle(json: unknown): GeoResult<Place> {
	const result = parseList(json, 1)
	if (result.error) return result
	return ok(result.data[0] as Place)
}

function parseList(json: unknown, limit: number): GeoResult<Place[]> {
	const parsed = z.safeParse(singleSchema, json)
	if (!parsed.success) {
		return err({
			code: 'BAD_RESPONSE',
			message: 'Invalid Geocod.io response',
			provider: 'geocod',
		})
	}
	if (parsed.data.error) {
		const msg = parsed.data.error
		if (/api key|unauthorized|forbidden/i.test(msg)) {
			return err({ code: 'AUTH', message: msg, provider: 'geocod' })
		}
		return err({ code: 'BAD_REQUEST', message: msg, provider: 'geocod' })
	}
	const rows = parsed.data.results?.slice(0, limit) ?? []
	if (!rows.length)
		return err({
			code: 'NOT_FOUND',
			message: 'No results',
			provider: 'geocod',
		})
	const places = rows.map(toPlace)
	return places.some(place => !place)
		? err({
				code: 'BAD_RESPONSE',
				message: 'Missing coordinates',
				provider: 'geocod',
			})
		: ok(places as Place[])
}

function queryBody(q: string): string
function queryBody(q: Exclude<AddressQuery, string>): Record<string, string>
function queryBody(q: AddressQuery): string | Record<string, string>
function queryBody(q: AddressQuery): string | Record<string, string> {
	if (typeof q === 'string') return q
	const body: Record<string, string> = {}
	if (q.streetNumber || q.street) {
		body.street = [q.streetNumber, q.street].filter(Boolean).join(' ')
	}
	if (q.street2) body.street2 = q.street2
	if (q.locality) body.city = q.locality
	if (q.region) body.state_province = q.region
	if (q.postcode) body.postal_code = q.postcode
	if (q.country) body.country = q.country
	return body
}

export type GeocodOptions = ApiKeyOptions

export function geocod({
	apiKey,
}: GeocodOptions): BatchProvider & SearchProvider {
	async function forward(
		query: AddressQuery,
		limit: number,
		opts?: ProviderRequestOpts,
	): Promise<GeoResult<unknown>> {
		const url = new URL('https://api.geocod.io/v1.12/geocode')
		url.searchParams.set('api_key', apiKey)
		url.searchParams.set('limit', String(limit))
		if (opts?.country) url.searchParams.set('country', opts.country)
		if (typeof query === 'string') {
			url.searchParams.set('q', query)
		} else {
			const body = queryBody(query)
			for (const [key, value] of Object.entries(body))
				url.searchParams.set(key, value)
		}
		return safeJson(url, {
			provider: 'geocod',
			signal: opts?.signal,
			timeoutMs: opts?.timeoutMs,
		})
	}

	async function geocode(
		query: AddressQuery,
		opts?: ProviderRequestOpts,
	): Promise<GeoResult<Place>> {
		// language: Geocod.io has no language param — best-effort no-op
		const json = await forward(query, 1, opts)
		if (json.error) return json
		return parseSingle(json.data)
	}

	async function search(
		query: string,
		opts?: SearchOpts,
	): Promise<GeoResult<Place[]>> {
		if (!query.trim())
			return err({
				code: 'BAD_REQUEST',
				message: 'Empty search query',
				provider: 'geocod',
			})
		const limit = opts?.limit ?? 5
		if (!Number.isInteger(limit) || limit < 1 || limit > 10)
			return err({
				code: 'BAD_REQUEST',
				message: 'limit must be an integer from 1 to 10',
				provider: 'geocod',
			})
		const json = await forward(query, limit, opts)
		if (json.error) return json
		return parseList(json.data, limit)
	}

	async function reverseGeocode(
		coords: Coords,
		opts?: ProviderRequestOpts,
	): Promise<GeoResult<Place>> {
		const url = new URL('https://api.geocod.io/v1.12/reverse')
		url.searchParams.set('api_key', apiKey)
		url.searchParams.set('q', `${coords.lat},${coords.lng}`)
		url.searchParams.set('limit', '1')
		if (opts?.country) url.searchParams.set('country', opts.country)
		const json = await safeJson(url, {
			provider: 'geocod',
			signal: opts?.signal,
			timeoutMs: opts?.timeoutMs,
		})
		if (json.error) return json
		return parseSingle(json.data)
	}

	async function geocodeBatch(
		queries: AddressQuery[],
		opts?: ProviderRequestOpts,
	): Promise<GeoResult<Place>[]> {
		const url = new URL('https://api.geocod.io/v1.12/geocode')
		url.searchParams.set('api_key', apiKey)
		url.searchParams.set('limit', '1')
		if (opts?.country) url.searchParams.set('country', opts.country)
		const json = await safeJson(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(queries.map(queryBody)),
			provider: 'geocod',
			signal: opts?.signal,
			timeoutMs: opts?.timeoutMs,
		})
		if (json.error) return queries.map(() => json)
		const parsed = z.safeParse(batchSchema, json.data)
		if (!parsed.success) {
			const e = err({
				code: 'BAD_RESPONSE',
				message: 'Invalid Geocod.io batch',
				provider: 'geocod',
			})
			return queries.map(() => e)
		}
		if (parsed.data.error) {
			const e = err({
				code: 'BAD_REQUEST',
				message: parsed.data.error,
				provider: 'geocod',
			})
			return queries.map(() => e)
		}
		const rows = parsed.data.results ?? []
		return queries.map((_, i) => {
			const row = rows[i]
			if (!row?.response)
				return err({
					code: 'NOT_FOUND',
					message: 'No results',
					provider: 'geocod',
				})
			return parseSingle(row.response)
		})
	}

	async function reverseGeocodeBatch(
		coordsList: Coords[],
		opts?: ProviderRequestOpts,
	): Promise<GeoResult<Place>[]> {
		const url = new URL('https://api.geocod.io/v1.12/reverse')
		url.searchParams.set('api_key', apiKey)
		url.searchParams.set('limit', '1')
		if (opts?.country) url.searchParams.set('country', opts.country)
		const json = await safeJson(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(coordsList.map(c => `${c.lat},${c.lng}`)),
			provider: 'geocod',
			signal: opts?.signal,
			timeoutMs: opts?.timeoutMs,
		})
		if (json.error) return coordsList.map(() => json)
		const parsed = z.safeParse(batchSchema, json.data)
		if (!parsed.success) {
			const e = err({
				code: 'BAD_RESPONSE',
				message: 'Invalid Geocod.io batch',
				provider: 'geocod',
			})
			return coordsList.map(() => e)
		}
		const rows = parsed.data.results ?? []
		return coordsList.map((_, i) => {
			const row = rows[i]
			if (!row?.response)
				return err({
					code: 'NOT_FOUND',
					message: 'No results',
					provider: 'geocod',
				})
			return parseSingle(row.response)
		})
	}

	return {
		name: 'geocod',
		defaultRateLimit: { maxPerMinute: 1000 },
		geocode,
		search,
		reverseGeocode,
		geocodeBatch,
		reverseGeocodeBatch,
	}
}
