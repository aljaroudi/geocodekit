import { expect, test } from 'bun:test'
import { createGeocoder } from '../src/createGeocoder.js'
import { geocod } from '../src/geocod.js'
import { google } from '../src/google.js'
import {
	geocodAccuracy,
	googleAccuracy,
	mapboxAccuracy,
} from '../src/map/accuracy.js'
import type {
	MapboxOptimizationProblem,
	MapboxOptimizationSolution,
	MapboxRoute,
} from '../src/mapbox.js'
import { mapbox } from '../src/mapbox.js'
import type { Provider } from '../src/providers/types.js'
import { createRateLimiter } from '../src/rate-limit.js'
import { isEmptyQuery, isValidCoords, refinePlace } from '../src/refine.js'
import { err, ok } from '../src/result.js'
import type { Place } from '../src/types.js'

const optimizationHeaders = () => ({ Authorization: 'Bearer token' })

const place: Place = {
	formatted: '1 Main St, Springfield, IL 62701, US',
	coordinates: { lat: 39.8, lng: -89.6 },
	components: {
		streetNumber: '1',
		street: 'Main St',
		locality: 'Springfield',
		region: 'IL',
		postcode: '62701',
		country: 'United States',
		countryCode: 'US',
	},
	accuracy: 'rooftop',
	provider: 'mapbox',
	id: 'test',
}

test('accuracy maps', () => {
	expect(mapboxAccuracy('rooftop')).toBe('rooftop')
	expect(googleAccuracy('RANGE_INTERPOLATED')).toBe('interpolated')
	expect(geocodAccuracy('place')).toBe('approximate')
})

test('refinePlace', () => {
	expect(refinePlace(place, { minAccuracy: 'rooftop' }).error).toBe(null)
	expect(
		refinePlace(place, { minAccuracy: 'rooftop', require: ['street'] }).error,
	).toBe(null)

	const low = refinePlace(
		{ ...place, accuracy: 'approximate' },
		{ minAccuracy: 'rooftop' },
	)
	expect(low.error).not.toBe(null)
	if (low.error) expect(low.error.code).toBe('LOW_ACCURACY')

	const missing = refinePlace(
		{ ...place, components: { ...place.components, street: undefined } },
		{ require: ['street'] },
	)
	expect(missing.error).not.toBe(null)
	if (missing.error) {
		expect(missing.error.code).toBe('MISSING_FIELDS')
		expect(missing.error.missing).toEqual(['street'])
	}

	const named = { ...place, name: 'City Hall' }
	expect(refinePlace(named, { require: ['name'] }).error).toBe(null)
	const noName = refinePlace(place, { require: ['name'] })
	expect(noName.error).not.toBe(null)
	if (noName.error) expect(noName.error.missing).toEqual(['name'])
})

test('query guards', () => {
	expect(isEmptyQuery('')).toBe(true)
	expect(isEmptyQuery({ locality: 'X' })).toBe(false)
	expect(isValidCoords({ lat: 0, lng: 0 })).toBe(true)
	expect(isValidCoords({ lat: 100, lng: 0 })).toBe(false)
})

test('rate limiter pacing', async () => {
	const pace = createRateLimiter({ maxPerMinute: 6000 })
	const t0 = Date.now()
	await pace()
	await pace()
	expect(Date.now() - t0).toBeGreaterThanOrEqual(5)
})

test('provider factories return Provider', () => {
	const providers: Provider[] = [
		mapbox({ apiKey: 'x' }),
		google({ apiKey: 'x' }),
		geocod({ apiKey: 'x' }),
	]
	expect(providers.map(p => p.name)).toEqual(['mapbox', 'google', 'geocod'])
})

test('geocoder', async () => {
	const mock: Provider = {
		name: 'mapbox',
		defaultRateLimit: { maxPerMinute: 1000 },
		async geocode() {
			return ok(place)
		},
		async reverseGeocode(c) {
			if (c.lat === 1 && c.lng === 1) return ok(place)
			return err({ code: 'NOT_FOUND', message: 'nope', provider: 'mapbox' })
		},
	}

	const failFirst: Provider = {
		name: 'google',
		defaultRateLimit: { maxPerMinute: 1000 },
		async geocode() {
			return err({ code: 'NOT_FOUND', message: 'miss', provider: 'google' })
		},
		async reverseGeocode() {
			return err({ code: 'NOT_FOUND', message: 'miss', provider: 'google' })
		},
	}

	const geo = createGeocoder({ providers: [failFirst, mock] })

	const g = await geo.geocode('anywhere')
	expect(g.error).toBe(null)
	if (!g.error) expect(g.data.provider).toBe('mapbox')

	const req = await geo.geocode('x', {
		require: ['street'],
		minAccuracy: 'rooftop',
	})
	expect(req.error).toBe(null)
	if (!req.error) {
		const street: string = req.data.components.street
		const acc: 'rooftop' = req.data.accuracy
		expect(street).toBe('Main St')
		expect(acc).toBe('rooftop')
	}

	const enriched = await geo.withAddress(
		{ id: 7, location: { lat: 1, lng: 1 } },
		{ getCoords: x => x.location },
	)
	expect(enriched.id).toBe(7)
	expect(enriched.address.error).toBe(null)

	const empty = await geo.geocode('')
	expect(empty.error).not.toBe(null)
	if (empty.error) expect(empty.error.code).toBe('BAD_REQUEST')
})

async function withFetch(
	body: unknown,
	run: () => Promise<void>,
): Promise<void> {
	const prev = globalThis.fetch
	globalThis.fetch = (async () =>
		Response.json(body)) as unknown as typeof fetch
	try {
		await run()
	} finally {
		globalThis.fetch = prev
	}
}

test('google maps unit county neighborhood', async () => {
	await withFetch(
		{
			status: 'OK',
			results: [
				{
					formatted_address: '1 Main St #2, Springfield, IL',
					place_id: 'ChIJx',
					address_components: [
						{ long_name: '2', short_name: '2', types: ['subpremise'] },
						{ long_name: '1', short_name: '1', types: ['street_number'] },
						{ long_name: 'Main St', short_name: 'Main St', types: ['route'] },
						{
							long_name: 'Downtown',
							short_name: 'Downtown',
							types: ['neighborhood'],
						},
						{
							long_name: 'Springfield',
							short_name: 'Springfield',
							types: ['locality'],
						},
						{
							long_name: 'Sangamon County',
							short_name: 'Sangamon County',
							types: ['administrative_area_level_2'],
						},
						{
							long_name: 'Illinois',
							short_name: 'IL',
							types: ['administrative_area_level_1'],
						},
						{
							long_name: 'United States',
							short_name: 'US',
							types: ['country'],
						},
					],
					geometry: {
						location: { lat: 39.8, lng: -89.6 },
						location_type: 'ROOFTOP',
					},
				},
			],
		},
		async () => {
			const r = await google({ apiKey: 'x' }).geocode('q')
			expect(r.error).toBe(null)
			if (!r.error) {
				expect(r.data.components.unit).toBe('2')
				expect(r.data.components.county).toBe('Sangamon County')
				expect(r.data.components.neighborhood).toBe('Downtown')
				expect(r.data.name).toBeUndefined()
				expect(r.data.id).toBe('ChIJx')
			}
		},
	)
})

test('google optimize sends one vehicle and normalizes its route', async () => {
	let request: { url: URL; init?: RequestInit } | undefined
	let authCalls = 0
	const prev = globalThis.fetch
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		request = { url: new URL(String(input)), init }
		return Response.json({
			routes: [{ visits: [{ shipmentIndex: 1 }, { shipmentIndex: 0 }] }],
			skippedShipments: [],
		})
	}) as unknown as typeof fetch
	try {
		const problem = {
			stops: [
				{ id: 'a', coordinates: { lat: 24.7, lng: 46.6 } },
				{ id: 'b', coordinates: { lat: 24.8, lng: 46.7 } },
			],
			start: { lat: 24.6, lng: 46.5 },
			end: { lat: 24.9, lng: 46.8 },
		}
		const client = google({
			apiKey: 'key',
			projectId: 'my-project',
			getOptimizationHeaders: () => {
				authCalls++
				return { Authorization: `Bearer token-${authCalls}` }
			},
		})
		const result = await client.optimize(problem, { timeoutMs: 45_500 })
		expect(result.data).toEqual({ order: ['b', 'a'], dropped: [] })
		expect(request?.url.pathname).toBe('/v1/projects/my-project:optimizeTours')
		expect(request?.init?.method).toBe('POST')
		const headers = new Headers(request?.init?.headers)
		expect(headers.get('Authorization')).toBe('Bearer token-1')
		expect(headers.get('X-Goog-Api-Key')).toBeNull()
		expect(headers.get('Content-Type')).toBe('application/json')
		expect(headers.get('X-Server-Timeout')).toBe('46')
		expect(JSON.parse(String(request?.init?.body))).toEqual({
			timeout: '46s',
			model: {
				shipments: [
					{
						deliveries: [
							{
								arrivalLocation: { latitude: 24.7, longitude: 46.6 },
							},
						],
					},
					{
						deliveries: [
							{
								arrivalLocation: { latitude: 24.8, longitude: 46.7 },
							},
						],
					},
				],
				vehicles: [
					{
						startLocation: { latitude: 24.6, longitude: 46.5 },
						endLocation: { latitude: 24.9, longitude: 46.8 },
						costPerTraveledHour: 1,
					},
				],
			},
		})
		await client.optimize(problem)
		expect(authCalls).toBe(2)
	} finally {
		globalThis.fetch = prev
	}
})

test('google optimize accepts 1000 stops', async () => {
	const stops = Array.from({ length: 1000 }, (_, index) => ({
		id: String(index),
		coordinates: { lat: 24 + index / 10000, lng: 46 },
	}))
	await withFetch(
		{
			routes: [
				{ visits: stops.map((_, shipmentIndex) => ({ shipmentIndex })) },
			],
			skippedShipments: [],
		},
		async () => {
			const result = await google({
				apiKey: 'x',
				projectId: 'project',
				getOptimizationHeaders: optimizationHeaders,
			}).optimize({ stops })
			expect(result.data?.order).toHaveLength(1000)
		},
	)
})

test('mapbox maps street from context and name for place features', async () => {
	await withFetch(
		{
			type: 'FeatureCollection',
			features: [
				{
					type: 'Feature',
					id: 'mb1',
					geometry: { type: 'Point', coordinates: [-77.03, 38.89] },
					properties: {
						mapbox_id: 'mb1',
						feature_type: 'place',
						name: 'Washington',
						name_preferred: 'Washington',
						full_address: 'Washington, District of Columbia, United States',
						coordinates: {
							longitude: -77.03,
							latitude: 38.89,
							accuracy: 'approximate',
						},
						context: {
							district: { name: 'District of Columbia' },
							neighborhood: { name: 'National Mall' },
							region: { name: 'District of Columbia' },
							country: { name: 'United States', country_code: 'us' },
						},
					},
				},
			],
		},
		async () => {
			const r = await mapbox({ apiKey: 'x' }).geocode('Washington')
			expect(r.error).toBe(null)
			if (!r.error) {
				expect(r.data.name).toBe('Washington')
				expect(r.data.components.street).toBeUndefined()
				expect(r.data.components.county).toBe('District of Columbia')
				expect(r.data.components.neighborhood).toBe('National Mall')
				expect(r.data.id).toBe('mb1')
			}
		},
	)
})

test('mapbox address uses context street not feature name', async () => {
	await withFetch(
		{
			type: 'FeatureCollection',
			features: [
				{
					type: 'Feature',
					geometry: { type: 'Point', coordinates: [-77.03655, 38.89768] },
					properties: {
						mapbox_id: 'addr1',
						feature_type: 'address',
						name: '1600 Pennsylvania Avenue Northwest',
						full_address:
							'1600 Pennsylvania Avenue Northwest, Washington, District of Columbia 20500, United States',
						coordinates: {
							longitude: -77.03655,
							latitude: 38.89768,
							accuracy: 'rooftop',
						},
						context: {
							address: {
								address_number: '1600',
								street_name: 'Pennsylvania Avenue Northwest',
								name: '1600 Pennsylvania Avenue Northwest',
							},
							street: { name: 'Pennsylvania Avenue Northwest' },
							place: { name: 'Washington' },
							district: { name: 'District of Columbia' },
							postcode: { name: '20500' },
							country: { name: 'United States', country_code: 'us' },
						},
					},
				},
			],
		},
		async () => {
			const r = await mapbox({ apiKey: 'x' }).geocode('1600 Pennsylvania')
			expect(r.error).toBe(null)
			if (!r.error) {
				expect(r.data.name).toBeUndefined()
				expect(r.data.components.streetNumber).toBe('1600')
				expect(r.data.components.street).toBe('Pennsylvania Avenue Northwest')
				expect(r.data.components.county).toBe('District of Columbia')
			}
		},
	)
})

test('mapbox permanent query param', async () => {
	const empty = { type: 'FeatureCollection', features: [] }
	const urls: string[] = []
	const prev = globalThis.fetch
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		urls.push(String(input))
		return Response.json(empty)
	}) as unknown as typeof fetch
	try {
		const geo = createGeocoder({ providers: [mapbox({ apiKey: 'x' })] })
		await geo.geocode('Berlin')
		await geo.geocode('Berlin', { permanent: true })
		expect(urls[0]).not.toContain('permanent=')
		expect(urls[1]).toContain('permanent=true')
	} finally {
		globalThis.fetch = prev
	}
})

const route: MapboxRoute = {
	weight_name: 'routability',
	weight: 12,
	duration: 10,
	distance: 100,
	geometry: {
		type: 'LineString',
		coordinates: [
			[1, 2],
			[3, 4],
		],
	},
	legs: [
		{
			summary: 'Main St',
			distance: 100,
			duration: 10,
			weight: 12,
			steps: [],
			annotation: { distance: [100] },
		},
	],
}

const optimizationProblem: MapboxOptimizationProblem = {
	version: 1,
	locations: [
		{ name: 'warehouse', coordinates: [46.6753, 24.7136] },
		{ name: 'customer', coordinates: [46.7, 24.72] },
	],
	vehicles: [
		{
			name: 'truck-1',
			routing_profile: 'mapbox/driving',
			start_location: 'warehouse',
			end_location: 'warehouse',
		},
	],
	services: [{ name: 'delivery-1', location: 'customer', duration: 60 }],
}

const optimizationSolution: MapboxOptimizationSolution = {
	dropped: { services: [], shipments: [] },
	routes: [
		{
			vehicle: 'truck-1',
			stops: [
				{
					type: 'service',
					location: 'customer',
					eta: '2026-08-10T12:00:00Z',
					odometer: 100,
					services: ['delivery-1'],
				},
			],
		},
	],
}

const normalizedOptimizationProblem = {
	stops: [
		{ id: 'first', coordinates: { lat: 24.7136, lng: 46.6753 } },
		{ id: 'second', coordinates: { lat: 24.72, lng: 46.7 } },
	],
	start: { lat: 24.7, lng: 46.6 },
	end: { lat: 24.8, lng: 46.8 },
} as const

test('mapbox directions serializes options and keeps extra fields', async () => {
	let request = new URL('https://example.com')
	const prev = globalThis.fetch
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		request = new URL(String(input))
		return Response.json({
			code: 'Ok',
			routes: [{ ...route, extra: 'kept' }],
			waypoints: [
				{ name: 'A', location: [1, 2] },
				{ name: 'B', location: [3, 4] },
			],
			uuid: 'route-id',
		})
	}) as unknown as typeof fetch
	try {
		const result = await mapbox({ apiKey: 'secret' }).directions(
			[
				{ lat: 2, lng: 1 },
				{ lat: 4, lng: 3 },
			],
			{
				profile: 'walking',
				geometries: 'geojson',
				overview: 'full',
				annotations: ['distance'],
				radiuses: [10, null],
				approaches: [null, 'curb'],
				alternatives: true,
				bearings: [[0, 45], null],
				exclude: ['ferry'],
				continueStraight: false,
				departAt: 'now',
			},
		)
		expect(request.pathname).toBe('/directions/v5/mapbox/walking/1,2;3,4')
		expect(request.searchParams.get('access_token')).toBe('secret')
		expect(request.searchParams.get('radiuses')).toBe('10;')
		expect(request.searchParams.get('approaches')).toBe(';curb')
		expect(request.searchParams.get('bearings')).toBe('0,45;')
		expect(request.searchParams.get('continue_straight')).toBe('false')
		expect(request.searchParams.get('depart_at')).toBe('now')
		expect(result.error).toBe(null)
		if (!result.error) {
			expect(result.data.routes[0]?.geometry).toEqual(route.geometry)
			expect(
				(result.data.routes[0] as unknown as Record<string, unknown>).extra,
			).toBe('kept')
		}
	} finally {
		globalThis.fetch = prev
	}
})

test('mapbox map matching defaults driving and returns tracepoints', async () => {
	let request = new URL('https://example.com')
	const prev = globalThis.fetch
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		request = new URL(String(input))
		return Response.json({
			code: 'Ok',
			matchings: [{ ...route, geometry: 'encoded', confidence: 0.9 }],
			tracepoints: [
				null,
				{
					name: 'B',
					location: [3, 4],
					matchings_index: 0,
					waypoint_index: 1,
				},
			],
		})
	}) as unknown as typeof fetch
	try {
		const result = await mapbox({ apiKey: 'x' }).mapMatch(
			[
				{ lat: 2, lng: 1 },
				{ lat: 4, lng: 3 },
			],
			{
				timestamps: [100, 105],
				tidy: true,
				waypoints: [0, 1],
				approaches: [null, 'curb'],
			},
		)
		expect(request.pathname).toBe('/matching/v5/mapbox/driving/1,2;3,4.json')
		expect(request.searchParams.get('timestamps')).toBe('100;105')
		expect(request.searchParams.get('tidy')).toBe('true')
		expect(request.searchParams.get('waypoints')).toBe('0;1')
		expect(result.error).toBe(null)
		if (!result.error) {
			expect(result.data.matchings[0]?.geometry).toBe('encoded')
			expect(result.data.tracepoints[0]).toBeNull()
		}
	} finally {
		globalThis.fetch = prev
	}
})

test('mapbox navigation validates input without fetching', async () => {
	let calls = 0
	const prev = globalThis.fetch
	globalThis.fetch = (async () => {
		calls++
		return Response.json({ code: 'Ok' })
	}) as unknown as typeof fetch
	try {
		const client = mapbox({ apiKey: 'x' })
		const tooFew = await client.directions([{ lat: 1, lng: 2 }])
		const invalid = await client.directions([
			{ lat: 91, lng: 2 },
			{ lat: 1, lng: 2 },
		])
		const mismatched = await client.mapMatch(
			[
				{ lat: 1, lng: 2 },
				{ lat: 3, lng: 4 },
			],
			{ radiuses: [5] },
		)
		const tooMany = await client.directions(
			Array.from({ length: 26 }, () => ({ lat: 1, lng: 2 })),
		)
		const timestamps = await client.mapMatch(
			[
				{ lat: 1, lng: 2 },
				{ lat: 3, lng: 4 },
			],
			{ timestamps: [105, 100] },
		)
		expect(tooFew.error?.code).toBe('BAD_REQUEST')
		expect(invalid.error?.code).toBe('BAD_REQUEST')
		expect(mismatched.error?.code).toBe('BAD_REQUEST')
		expect(tooMany.error?.code).toBe('BAD_REQUEST')
		expect(timestamps.error?.code).toBe('BAD_REQUEST')
		expect(calls).toBe(0)
	} finally {
		globalThis.fetch = prev
	}
})

test('mapbox navigation maps API and malformed response errors', async () => {
	const coords = [
		{ lat: 1, lng: 2 },
		{ lat: 3, lng: 4 },
	]
	await withFetch({ code: 'NoMatch', message: 'No match' }, async () => {
		const result = await mapbox({ apiKey: 'x' }).mapMatch(coords)
		expect(result.error?.code).toBe('NOT_FOUND')
	})
	await withFetch({ code: 'Ok', matchings: 'bad' }, async () => {
		const result = await mapbox({ apiKey: 'x' }).mapMatch(coords)
		expect(result.error?.code).toBe('BAD_RESPONSE')
	})
})

test('mapbox optimization lifecycle', async () => {
	const requests: Array<{ url: URL; init?: RequestInit }> = []
	const responses = [
		Response.json({ id: 'job-1', status: 'ok' }, { status: 202 }),
		Response.json([{ id: 'job-1', status: 'processing' }]),
		new Response(null, { status: 202 }),
		Response.json({ ...optimizationSolution, extra: 'kept' }),
	]
	const prev = globalThis.fetch
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		requests.push({ url: new URL(String(input)), init })
		const response = responses.shift()
		if (!response) throw new Error('Unexpected fetch')
		return response
	}) as unknown as typeof fetch
	try {
		const client = mapbox({ apiKey: 'secret' })
		const submitted = await client.submitOptimization(optimizationProblem)
		const listed = await client.listOptimizations()
		const pending = await client.getOptimization('job-1')
		const complete = await client.getOptimization('job-1')

		expect(requests[0]?.url.pathname).toBe('/optimized-trips/v2')
		expect(requests[0]?.url.searchParams.get('access_token')).toBe('secret')
		expect(requests.slice(1).map(({ url }) => url.pathname)).toEqual([
			'/optimized-trips/v2',
			'/optimized-trips/v2/job-1',
			'/optimized-trips/v2/job-1',
		])
		expect(requests[0]?.init?.method).toBe('POST')
		expect(requests[0]?.init?.headers).toEqual({
			'Content-Type': 'application/json',
		})
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(
			optimizationProblem,
		)
		expect(submitted.data?.id).toBe('job-1')
		expect(listed.data?.[0]?.status).toBe('processing')
		expect(pending.data).toEqual({ complete: false })
		expect(complete.error).toBe(null)
		if (!complete.error && complete.data.complete) {
			expect(complete.data.solution.routes[0]?.vehicle).toBe('truck-1')
			expect(
				(complete.data.solution as unknown as Record<string, unknown>).extra,
			).toBe('kept')
		}
	} finally {
		globalThis.fetch = prev
	}
})

test('mapbox optimizeV2 submits and returns completed solution', async () => {
	let calls = 0
	const prev = globalThis.fetch
	globalThis.fetch = (async () => {
		calls++
		return calls === 1
			? Response.json({ id: 'job-1', status: 'ok' }, { status: 202 })
			: Response.json(optimizationSolution)
	}) as unknown as typeof fetch
	try {
		const result = await mapbox({ apiKey: 'x' }).optimizeV2(optimizationProblem)
		expect(result.data).toEqual(optimizationSolution)
		expect(calls).toBe(2)
	} finally {
		globalThis.fetch = prev
	}
})

test('mapbox optimize converts and normalizes a single vehicle route', async () => {
	let body: Record<string, unknown> | undefined
	let calls = 0
	const prev = globalThis.fetch
	globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		calls++
		if (calls === 1) {
			body = JSON.parse(String(init?.body)) as Record<string, unknown>
			return Response.json({ id: 'job-1', status: 'ok' }, { status: 202 })
		}
		return Response.json({
			dropped: { services: [], shipments: [] },
			routes: [
				{
					vehicle: 'vehicle',
					stops: [
						{
							type: 'service',
							eta: '2026-08-10T12:00:00Z',
							services: ['stop-1'],
						},
						{
							type: 'service',
							eta: '2026-08-10T12:10:00Z',
							services: ['stop-0'],
						},
					],
				},
			],
		})
	}) as unknown as typeof fetch
	try {
		const result = await mapbox({ apiKey: 'x' }).optimize(
			normalizedOptimizationProblem,
		)
		expect(result.data).toEqual({ order: ['second', 'first'], dropped: [] })
		expect(body).toEqual({
			version: 1,
			locations: [
				{ name: 'stop-0', coordinates: [46.6753, 24.7136] },
				{ name: 'stop-1', coordinates: [46.7, 24.72] },
				{ name: 'route-start', coordinates: [46.6, 24.7] },
				{ name: 'route-end', coordinates: [46.8, 24.8] },
			],
			vehicles: [
				{
					name: 'vehicle',
					routing_profile: 'mapbox/driving',
					start_location: 'route-start',
					end_location: 'route-end',
				},
			],
			services: [
				{ name: 'stop-0', location: 'stop-0' },
				{ name: 'stop-1', location: 'stop-1' },
			],
			options: { objectives: ['min-total-travel-duration'] },
		})
	} finally {
		globalThis.fetch = prev
	}
})

test('shared optimization rejects invalid input without fetching', async () => {
	let calls = 0
	const prev = globalThis.fetch
	globalThis.fetch = (async () => {
		calls++
		return Response.json({})
	}) as unknown as typeof fetch
	try {
		const duplicate = {
			stops: [
				{ id: 'same', coordinates: { lat: 1, lng: 2 } },
				{ id: 'same', coordinates: { lat: 3, lng: 4 } },
			],
		}
		const mapboxResult = await mapbox({ apiKey: 'x' }).optimize(duplicate)
		const googleResult = await google({
			apiKey: 'x',
			projectId: 'project',
			getOptimizationHeaders: optimizationHeaders,
		}).optimize(duplicate)
		const missingProject = await google({ apiKey: 'x' }).optimize(
			normalizedOptimizationProblem,
		)
		const badTimeout = await google({
			apiKey: 'x',
			projectId: 'project',
			getOptimizationHeaders: optimizationHeaders,
		}).optimize(normalizedOptimizationProblem, { timeoutMs: 0 })
		const missingAuth = await google({
			apiKey: 'x',
			projectId: 'project',
		}).optimize(normalizedOptimizationProblem)
		const rejectedAuth = await google({
			apiKey: 'x',
			projectId: 'project',
			getOptimizationHeaders: () => Promise.reject(new Error('no token')),
		}).optimize(normalizedOptimizationProblem)
		const invalidAuth = await google({
			apiKey: 'x',
			projectId: 'project',
			getOptimizationHeaders: () => ({}),
		}).optimize(normalizedOptimizationProblem)

		expect(mapboxResult.error?.code).toBe('BAD_REQUEST')
		expect(googleResult.error?.code).toBe('BAD_REQUEST')
		expect(missingProject.error?.code).toBe('BAD_REQUEST')
		expect(badTimeout.error?.code).toBe('BAD_REQUEST')
		expect(missingAuth.error?.code).toBe('AUTH')
		expect(rejectedAuth.error?.code).toBe('AUTH')
		expect(invalidAuth.error?.code).toBe('AUTH')
		expect(calls).toBe(0)
	} finally {
		globalThis.fetch = prev
	}
})

test('optimization rejects incomplete provider stop orders', async () => {
	await withFetch({ routes: 'bad' }, async () => {
		const result = await google({
			apiKey: 'x',
			projectId: 'project',
			getOptimizationHeaders: optimizationHeaders,
		}).optimize(normalizedOptimizationProblem)
		expect(result.error?.code).toBe('BAD_RESPONSE')
	})

	await withFetch(
		{
			routes: [{ visits: [{ shipmentIndex: 0 }] }],
			skippedShipments: [],
		},
		async () => {
			const result = await google({
				apiKey: 'x',
				projectId: 'project',
				getOptimizationHeaders: optimizationHeaders,
			}).optimize(normalizedOptimizationProblem)
			expect(result.error?.code).toBe('BAD_RESPONSE')
		},
	)

	let calls = 0
	const prev = globalThis.fetch
	globalThis.fetch = (async () => {
		calls++
		return calls === 1
			? Response.json({ id: 'job-1', status: 'ok' }, { status: 202 })
			: Response.json({
					dropped: { services: [], shipments: [] },
					routes: [
						{
							vehicle: 'vehicle',
							stops: [
								{
									type: 'service',
									eta: '2026-08-10T12:00:00Z',
									services: ['stop-0'],
								},
							],
						},
					],
				})
	}) as unknown as typeof fetch
	try {
		const result = await mapbox({ apiKey: 'x' }).optimize(
			normalizedOptimizationProblem,
		)
		expect(result.error?.code).toBe('BAD_RESPONSE')
	} finally {
		globalThis.fetch = prev
	}
})

test('google optimize maps abort, timeout, and HTTP errors', async () => {
	const client = google({
		apiKey: 'x',
		projectId: 'project',
		getOptimizationHeaders: optimizationHeaders,
	})
	const abortedController = new AbortController()
	abortedController.abort()
	const aborted = await client.optimize(normalizedOptimizationProblem, {
		signal: abortedController.signal,
	})
	expect(aborted.error?.code).toBe('ABORTED')

	const prev = globalThis.fetch
	globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener(
				'abort',
				() => reject(init.signal?.reason),
				{ once: true },
			)
		})) as unknown as typeof fetch
	try {
		const timedOut = await client.optimize(normalizedOptimizationProblem, {
			timeoutMs: 5,
		})
		expect(timedOut.error?.code).toBe('TIMEOUT')
	} finally {
		globalThis.fetch = prev
	}

	const prevRateLimit = globalThis.fetch
	globalThis.fetch = (async () =>
		new Response(null, { status: 429 })) as unknown as typeof fetch
	try {
		const rateLimited = await client.optimize(normalizedOptimizationProblem)
		expect(rateLimited.error?.code).toBe('RATE_LIMIT')
	} finally {
		globalThis.fetch = prevRateLimit
	}
})

test('mapbox optimization validates, aborts, times out, and maps errors', async () => {
	let calls = 0
	const prev = globalThis.fetch
	globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		calls++
		if (init?.method === 'POST')
			return Response.json({ id: 'job-1', status: 'ok' }, { status: 202 })
		return new Response(null, { status: 202 })
	}) as unknown as typeof fetch
	try {
		const client = mapbox({ apiKey: 'x' })
		const invalid = await client.submitOptimization({
			...optimizationProblem,
			locations: [],
		})
		const fastPoll = await client.optimizeV2(optimizationProblem, {
			pollIntervalMs: 999,
		})
		expect(invalid.error?.code).toBe('BAD_REQUEST')
		expect(fastPoll.error?.code).toBe('BAD_REQUEST')
		expect(calls).toBe(0)

		const ac = new AbortController()
		ac.abort()
		const aborted = await client.optimizeV2(optimizationProblem, {
			signal: ac.signal,
		})
		expect(aborted.error?.code).toBe('ABORTED')
		expect(calls).toBe(0)

		const timedOut = await client.optimizeV2(optimizationProblem, {
			maxWaitMs: 1,
		})
		expect(timedOut.error?.code).toBe('TIMEOUT')
	} finally {
		globalThis.fetch = prev
	}

	await withFetch({}, async () => {
		const malformed = await mapbox({ apiKey: 'x' }).getOptimization('job-1')
		expect(malformed.error?.code).toBe('BAD_RESPONSE')
	})
	const prev404 = globalThis.fetch
	globalThis.fetch = (async () =>
		new Response(null, { status: 404 })) as unknown as typeof fetch
	try {
		const missing = await mapbox({ apiKey: 'x' }).getOptimization('missing')
		expect(missing.error?.code).toBe('NOT_FOUND')
	} finally {
		globalThis.fetch = prev404
	}
})

test('geocod maps addressee county unit id', async () => {
	await withFetch(
		{
			results: [
				{
					addressee: 'Acme Inc',
					stable_address_key: 'gcod_usndjrg9xn28uz888u3fkm6yusrdg',
					formatted_address: '1109 N Highland St, Arlington, VA 22201',
					address_components: {
						number: '1109',
						formatted_street: 'N Highland St',
						street2: 'Suite 200',
						city: 'Arlington',
						county: 'Arlington County',
						state_province: 'VA',
						postal_code: '22201',
						country: 'US',
					},
					location: { lat: 38.886672, lng: -77.094735 },
					accuracy_type: 'rooftop',
				},
			],
		},
		async () => {
			const r = await geocod({ apiKey: 'x' }).geocode('q')
			expect(r.error).toBe(null)
			if (!r.error) {
				expect(r.data.name).toBe('Acme Inc')
				expect(r.data.id).toBe('gcod_usndjrg9xn28uz888u3fkm6yusrdg')
				expect(r.data.components.county).toBe('Arlington County')
				expect(r.data.components.unit).toBe('Suite 200')
			}
		},
	)
})
