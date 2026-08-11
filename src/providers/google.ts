import * as z from 'zod/mini'
import { safeJson } from '../fetch.js'
import { googleAccuracy } from '../map/accuracy.js'
import {
	normalizeOptimizationSolution,
	type OptimizationProblem,
	type OptimizationProvider,
	type OptimizationSolution,
	type OptimizeOptions,
	validateOptimizationProblem,
} from '../optimization.js'
import { err, ok } from '../result.js'
import type { AddressQuery, GeoResult, Place, SearchOpts } from '../types.js'
import type {
	ApiKeyOptions,
	ProviderRequestOpts,
	SearchProvider,
} from './types.js'

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

const optimizationResponseSchema = z.object({
	routes: z.array(
		z.object({
			routePolyline: z.optional(z.object({ points: z.string() })),
			visits: z.array(z.object({ shipmentIndex: z.optional(z.number()) })),
		}),
	),
	skippedShipments: z.optional(
		z.array(z.object({ index: z.optional(z.number()) })),
	),
})

function decodePolyline(value: string): [number, number][] {
	const path: [number, number][] = []
	let index = 0
	let lat = 0
	let lng = 0
	const read = () => {
		let result = 0
		let shift = 0
		let byte: number
		do {
			if (index >= value.length || shift > 30) throw new Error()
			byte = value.charCodeAt(index++) - 63
			if (byte < 0 || byte > 63) throw new Error()
			result |= (byte & 0x1f) << shift
			shift += 5
		} while (byte >= 0x20)
		return result & 1 ? ~(result >> 1) : result >> 1
	}
	while (index < value.length) {
		lat += read()
		lng += read()
		path.push([lng / 1e5, lat / 1e5])
	}
	if (path.length < 2) throw new Error()
	return path
}

function pickComponent(
	components: z.infer<typeof componentSchema>[] | undefined,
	type: string,
	short = false,
): string | undefined {
	const c = components?.find(x => x.types.includes(type))
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

function statusError(status: string, message?: string): GeoResult<never> {
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
	const result = parseResponseList(json, 1)
	if (result.error) return result
	return ok(result.data[0] as Place)
}

function parseResponseList(json: unknown, limit: number): GeoResult<Place[]> {
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
	const rows = results?.slice(0, limit) ?? []
	if (!rows.length)
		return err({ code: 'NOT_FOUND', message: 'No results', provider: 'google' })
	const places = rows.map(toPlace)
	return places.some(place => !place)
		? err({
				code: 'BAD_RESPONSE',
				message: 'Missing coordinates',
				provider: 'google',
			})
		: ok(places as Place[])
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

export type GoogleOptions = ApiKeyOptions & {
	projectId?: string
	getOptimizationHeaders?: () => HeadersInit | Promise<HeadersInit>
}
export type GoogleClient = OptimizationProvider & SearchProvider

export function google({
	apiKey,
	projectId,
	getOptimizationHeaders,
}: GoogleOptions): GoogleClient {
	async function forward(
		query: AddressQuery,
		opts?: ProviderRequestOpts,
	): Promise<GeoResult<unknown>> {
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
		return safeJson(url, {
			provider: 'google',
			signal: opts?.signal,
			timeoutMs: opts?.timeoutMs,
		})
	}

	async function optimize(
		problem: OptimizationProblem,
		opts?: OptimizeOptions,
	): Promise<GeoResult<OptimizationSolution>> {
		const invalid = validateOptimizationProblem(problem, opts, 'google')
		if (invalid) return invalid
		if (!projectId?.trim())
			return err({
				code: 'BAD_REQUEST',
				message: 'Google projectId is required for optimization',
				provider: 'google',
			})
		if (!getOptimizationHeaders)
			return err({
				code: 'AUTH',
				message: 'Google optimization auth headers are required',
				provider: 'google',
			})

		let headers: Headers
		try {
			headers = new Headers(await getOptimizationHeaders())
		} catch {
			return err({
				code: 'AUTH',
				message: 'Failed to get Google optimization auth headers',
				provider: 'google',
			})
		}
		if (!headers.has('Authorization'))
			return err({
				code: 'AUTH',
				message: 'Google optimization Authorization header is required',
				provider: 'google',
			})

		const timeoutSeconds = opts?.timeoutMs
			? Math.max(1, Math.ceil(opts.timeoutMs / 1000))
			: undefined
		const url = new URL(
			`https://routeoptimization.googleapis.com/v1/projects/${encodeURIComponent(projectId)}:optimizeTours`,
		)
		headers.set('Content-Type', 'application/json')
		if (timeoutSeconds) headers.set('X-Server-Timeout', String(timeoutSeconds))
		const json = await safeJson(url, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				...(timeoutSeconds ? { timeout: `${timeoutSeconds}s` } : {}),
				populatePolylines: true,
				model: {
					shipments: problem.stops.map(stop => ({
						deliveries: [
							{
								arrivalLocation: {
									latitude: stop.coordinates.lat,
									longitude: stop.coordinates.lng,
								},
							},
						],
					})),
					vehicles: [
						{
							...(problem.start
								? {
										startLocation: {
											latitude: problem.start.lat,
											longitude: problem.start.lng,
										},
									}
								: {}),
							...(problem.end
								? {
										endLocation: {
											latitude: problem.end.lat,
											longitude: problem.end.lng,
										},
									}
								: {}),
							costPerTraveledHour: 1,
						},
					],
				},
			}),
			provider: 'google',
			signal: opts?.signal,
			timeoutMs: opts?.timeoutMs,
		})
		if (json.error) return json
		const parsed = z.safeParse(optimizationResponseSchema, json.data)
		if (!parsed.success)
			return err({
				code: 'BAD_RESPONSE',
				message: 'Invalid Google optimization response',
				provider: 'google',
			})

		const orderIndexes = parsed.data.routes.flatMap(route =>
			route.visits.map(visit => visit.shipmentIndex ?? 0),
		)
		const droppedIndexes = (parsed.data.skippedShipments ?? []).map(
			shipment => shipment.index ?? 0,
		)
		let path: [number, number][] | undefined
		if (orderIndexes.length) {
			try {
				const polyline = parsed.data.routes[0]?.routePolyline?.points
				if (!polyline) throw new Error()
				path = decodePolyline(polyline)
			} catch {
				return err({
					code: 'BAD_RESPONSE',
					message: 'Invalid Google optimization route polyline',
					provider: 'google',
				})
			}
		}
		const indexes = [...orderIndexes, ...droppedIndexes]
		if (
			indexes.some(
				index =>
					!Number.isInteger(index) ||
					index < 0 ||
					index >= problem.stops.length,
			)
		)
			return err({
				code: 'BAD_RESPONSE',
				message: 'Invalid Google optimization shipment index',
				provider: 'google',
			})
		return normalizeOptimizationSolution(
			problem,
			orderIndexes.map(index => problem.stops[index]?.id as string),
			droppedIndexes.map(index => problem.stops[index]?.id as string),
			'google',
			path,
		)
	}

	return {
		name: 'google',
		defaultRateLimit: { maxPerMinute: 3000 },
		geocode: async (query, opts) => {
			const json = await forward(query, opts)
			if (json.error) return json
			return parseResponse(json.data)
		},
		search: async (query, opts?: SearchOpts) => {
			if (!query.trim())
				return err({
					code: 'BAD_REQUEST',
					message: 'Empty search query',
					provider: 'google',
				})
			const limit = opts?.limit ?? 5
			if (!Number.isInteger(limit) || limit < 1 || limit > 10)
				return err({
					code: 'BAD_REQUEST',
					message: 'limit must be an integer from 1 to 10',
					provider: 'google',
				})
			const json = await forward(query, opts)
			if (json.error) return json
			return parseResponseList(json.data, limit)
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
		optimize,
	}
}
