import * as z from 'zod/mini'
import { safeJson } from '../fetch.js'
import { googleAccuracy } from '../map/accuracy.js'
import { err, ok } from '../result.js'
import type { AddressQuery, GeoResult, Place } from '../types.js'
import type { ApiKeyOptions, Provider } from './types.js'

const componentSchema = z.object({
	long_name: z.string(),
	short_name: z.string(),
	types: z.array(z.string()),
})

const resultSchema = z.object({
	formatted_address: z.optional(z.string()),
	place_id: z.optional(z.string()),
	address_components: z.optional(z.array(componentSchema)),
	geometry: z.optional(
		z.object({
			location: z.optional(
				z.object({
					lat: z.number(),
					lng: z.number(),
				}),
			),
			location_type: z.optional(z.string()),
		}),
	),
})

const responseSchema = z.object({
	status: z.string(),
	error_message: z.optional(z.string()),
	results: z.optional(z.array(resultSchema)),
})

function pickComponent(
	components: z.infer<typeof componentSchema>[] | undefined,
	type: string,
	short = false,
): string | undefined {
	const c = components?.find((x) => x.types.includes(type))
	return c ? (short ? c.short_name : c.long_name) : undefined
}

function toPlace(r: z.infer<typeof resultSchema>): Place | null {
	const loc = r.geometry?.location
	if (!loc) return null
	const ac = r.address_components
	return {
		formatted: r.formatted_address ?? `${loc.lat},${loc.lng}`,
		coordinates: { lat: loc.lat, lng: loc.lng },
		components: {
			streetNumber: pickComponent(ac, 'street_number'),
			street: pickComponent(ac, 'route'),
			unit: pickComponent(ac, 'subpremise'),
			locality:
				pickComponent(ac, 'locality') ??
				pickComponent(ac, 'postal_town') ??
				pickComponent(ac, 'sublocality') ??
				pickComponent(ac, 'sublocality_level_1'),
			neighborhood: pickComponent(ac, 'neighborhood'),
			county: pickComponent(ac, 'administrative_area_level_2'),
			region: pickComponent(ac, 'administrative_area_level_1'),
			postcode: pickComponent(ac, 'postal_code'),
			country: pickComponent(ac, 'country'),
			countryCode: pickComponent(ac, 'country', true)?.toUpperCase(),
		},
		accuracy: googleAccuracy(r.geometry?.location_type),
		provider: 'google',
		id: r.place_id,
	}
}

function statusError(status: string, message?: string): GeoResult<Place> {
	switch (status) {
		case 'ZERO_RESULTS':
			return err({
				code: 'NOT_FOUND',
				message: message ?? 'No results',
				provider: 'google',
			})
		case 'OVER_QUERY_LIMIT':
		case 'OVER_DAILY_LIMIT':
			return err({
				code: 'RATE_LIMIT',
				message: message ?? status,
				provider: 'google',
			})
		case 'REQUEST_DENIED':
			return err({
				code: 'AUTH',
				message: message ?? status,
				provider: 'google',
			})
		case 'INVALID_REQUEST':
			return err({
				code: 'BAD_REQUEST',
				message: message ?? status,
				provider: 'google',
			})
		case 'UNKNOWN_ERROR':
			return err({
				code: 'PROVIDER_DOWN',
				message: message ?? status,
				provider: 'google',
			})
		default:
			return err({
				code: 'BAD_RESPONSE',
				message: message ?? status,
				provider: 'google',
			})
	}
}

function parseResponse(json: unknown): GeoResult<Place> {
	const parsed = z.safeParse(responseSchema, json)
	if (!parsed.success) {
		return err({
			code: 'BAD_RESPONSE',
			message: 'Invalid Google response',
			provider: 'google',
		})
	}
	const { status, error_message, results } = parsed.data
	if (status !== 'OK') return statusError(status, error_message)
	const first = results?.[0]
	if (!first)
		return err({ code: 'NOT_FOUND', message: 'No results', provider: 'google' })
	const place = toPlace(first)
	if (!place)
		return err({
			code: 'BAD_RESPONSE',
			message: 'Missing coordinates',
			provider: 'google',
		})
	return ok(place)
}

function structuredToComponents(q: Exclude<AddressQuery, string>): string {
	const parts: string[] = []
	if (q.streetNumber || q.street) {
		parts.push(`route:${[q.streetNumber, q.street].filter(Boolean).join(' ')}`)
	}
	if (q.locality) parts.push(`locality:${q.locality}`)
	if (q.region) parts.push(`administrative_area:${q.region}`)
	if (q.postcode) parts.push(`postal_code:${q.postcode}`)
	if (q.country) parts.push(`country:${q.country}`)
	return parts.join('|')
}

function structuredToAddress(q: Exclude<AddressQuery, string>): string {
	return [
		q.streetNumber,
		q.street,
		q.street2,
		q.locality,
		q.region,
		q.postcode,
		q.country,
	]
		.filter(Boolean)
		.join(', ')
}

export type GoogleOptions = ApiKeyOptions

export function google({ apiKey }: GoogleOptions): Provider {
	return {
		name: 'google',
		defaultRateLimit: { maxPerMinute: 3000 },
		geocode: async (query, opts) => {
			const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
			url.searchParams.set('key', apiKey)
			if (opts?.language) url.searchParams.set('language', opts.language)
			if (opts?.country)
				url.searchParams.set('region', opts.country.toLowerCase())
			if (typeof query === 'string') {
				url.searchParams.set('address', query)
			} else {
				const address = structuredToAddress(query)
				const components = structuredToComponents(query)
				if (address) url.searchParams.set('address', address)
				if (components) url.searchParams.set('components', components)
			}
			const json = await safeJson(url, {
				provider: 'google',
				signal: opts?.signal,
				timeoutMs: opts?.timeoutMs,
			})
			if (json.error) return json
			return parseResponse(json.data)
		},
		reverseGeocode: async (coords, opts) => {
			const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
			url.searchParams.set('key', apiKey)
			url.searchParams.set('latlng', `${coords.lat},${coords.lng}`)
			if (opts?.language) url.searchParams.set('language', opts.language)
			if (opts?.country)
				url.searchParams.set('region', opts.country.toLowerCase())
			const json = await safeJson(url, {
				provider: 'google',
				signal: opts?.signal,
				timeoutMs: opts?.timeoutMs,
			})
			if (json.error) return json
			return parseResponse(json.data)
		},
	}
}
