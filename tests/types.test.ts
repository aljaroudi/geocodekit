import { expect, test } from 'bun:test'
import { createGeocoder } from '../src/createGeocoder.js'
import { geocod } from '../src/geocod.js'
import { google } from '../src/google.js'
import type {
	MapboxDirectionsOptions,
	MapboxDirectionsResponse,
	MapboxMapMatchingOptions,
	MapboxMapMatchingResponse,
	MapboxOptimizationPoll,
	MapboxOptimizationProblem,
	MapboxOptimizationSolution,
	MapboxOptimizationSubmission,
} from '../src/mapbox.js'
import { mapbox } from '../src/mapbox.js'
import type { Provider } from '../src/providers/types.js'
import { ok } from '../src/result.js'
import type { Coords, GeoResult, Place } from '../src/types.js'

test('mode batch allowed when a provider supports batch', () => {
	const geo = createGeocoder({ providers: [mapbox({ apiKey: 'x' })] })
	// Compile-time: mode 'batch' is valid
	const opts = { mode: 'batch' as const }
	void geo.geocode(['a'], opts)
	void createGeocoder({
		providers: [geocod({ apiKey: 'x' }), google({ apiKey: 'x' })],
	}).geocode(['a'], { mode: 'batch' })
	expect(opts.mode).toBe('batch')
})

test('mode batch rejected when no provider supports batch', () => {
	const geo = createGeocoder({ providers: [google({ apiKey: 'x' })] })
	void geo.geocode(['a'], { mode: 'sequential' })
	void geo.geocode(['a'], { mode: 'auto' })
	// @ts-expect-error batch unsupported when no provider has geocodeBatch
	void geo.geocode(['a'], { mode: 'batch' })

	const widened: Provider[] = [mapbox({ apiKey: 'x' })]
	const loose = createGeocoder({
		providers: widened as [Provider, ...Provider[]],
	})
	// @ts-expect-error widened Provider[] does not prove batch support
	void loose.geocode(['a'], { mode: 'batch' })
	expect(true).toBe(true)
})

test('require narrows name and new components', async () => {
	const place: Place = {
		formatted: 'Acme, 1 Main St',
		coordinates: { lat: 1, lng: 2 },
		components: {
			street: 'Main St',
			county: 'Arlington County',
			locality: 'Arlington',
		},
		accuracy: 'rooftop',
		provider: 'geocod',
		name: 'Acme',
	}
	const mock: Provider = {
		name: 'geocod',
		defaultRateLimit: { maxPerMinute: 1000 },
		async geocode() {
			return ok(place)
		},
		async reverseGeocode() {
			return ok(place)
		},
	}
	const geo = createGeocoder({ providers: [mock] })

	const narrowed = await geo.geocode('x', {
		require: ['name', 'county', 'street'],
	})
	expect(narrowed.error).toBe(null)
	if (!narrowed.error) {
		const name: string = narrowed.data.name
		const county: string = narrowed.data.components.county
		const street: string = narrowed.data.components.street
		expect(name).toBe('Acme')
		expect(county).toBe('Arlington County')
		expect(street).toBe('Main St')
	}

	const loose = await geo.geocode('x')
	if (!loose.error) {
		// @ts-expect-error name stays optional without require
		const _n: string = loose.data.name
		void _n
	}

	// @ts-expect-error bbox is not a RequireKey
	void geo.geocode('x', { require: ['bbox'] })
})

test('mapbox navigation methods expose typed results', () => {
	const client = mapbox({ apiKey: 'x' })
	const directions: (
		coords: Coords[],
		opts?: MapboxDirectionsOptions,
	) => Promise<GeoResult<MapboxDirectionsResponse>> = client.directions
	const mapMatch: (
		coords: Coords[],
		opts?: MapboxMapMatchingOptions,
	) => Promise<GeoResult<MapboxMapMatchingResponse>> = client.mapMatch
	expect(typeof directions).toBe('function')
	expect(typeof mapMatch).toBe('function')
})

test('mapbox optimization methods expose wire types', () => {
	const problem = {
		version: 1,
		locations: [
			{ name: 'warehouse', coordinates: [46.6753, 24.7136] },
			{ name: 'customer', coordinates: [46.7, 24.72] },
		],
		vehicles: [
			{
				name: 'truck-1',
				routing_profile: 'mapbox/driving-traffic',
				start_location: 'warehouse',
				end_location: 'warehouse',
				capacities: { boxes: 10 },
				capabilities: ['refrigeration'],
				earliest_start: '2026-08-10T09:00:00Z',
				latest_end: '2026-08-10T17:00:00Z',
				breaks: [
					{
						earliest_start: '2026-08-10T12:00:00Z',
						latest_end: '2026-08-10T13:00:00Z',
						duration: 1800,
					},
				],
				loading_policy: 'fifo',
			},
		],
		services: [
			{
				name: 'service-1',
				location: 'customer',
				duration: 60,
				requirements: ['refrigeration'],
				service_times: [
					{
						earliest: '2026-08-10T10:00:00Z',
						latest: '2026-08-10T11:00:00Z',
						type: 'strict',
					},
				],
			},
		],
		shipments: [
			{
				name: 'shipment-1',
				from: 'warehouse',
				to: 'customer',
				size: { boxes: 1 },
				requirements: ['refrigeration'],
				pickup_duration: 30,
				dropoff_duration: 60,
				pickup_times: [
					{
						earliest: '2026-08-10T09:00:00Z',
						latest: '2026-08-10T10:00:00Z',
						type: 'soft_start',
					},
				],
				dropoff_times: [
					{
						earliest: '2026-08-10T10:00:00Z',
						latest: '2026-08-10T12:00:00Z',
						type: 'soft_end',
					},
				],
			},
		],
		options: { objectives: ['min-total-travel-duration'] },
	} as const satisfies MapboxOptimizationProblem

	const client = mapbox({ apiKey: 'x' })
	const submit: (
		problem: MapboxOptimizationProblem,
	) => Promise<GeoResult<MapboxOptimizationSubmission>> =
		client.submitOptimization
	const get: (id: string) => Promise<GeoResult<MapboxOptimizationPoll>> =
		client.getOptimization
	const list: () => Promise<GeoResult<MapboxOptimizationSubmission[]>> =
		client.listOptimizations
	const optimize: (
		problem: MapboxOptimizationProblem,
	) => Promise<GeoResult<MapboxOptimizationSolution>> = client.optimize
	expect(
		[submit, get, list, optimize].every(fn => typeof fn === 'function'),
	).toBe(true)
	expect(problem.version).toBe(1)
})
