import { expect, test } from 'bun:test'
import { createGeocoder } from '../src/createGeocoder.js'
import { geocod } from '../src/geocod.js'
import { google } from '../src/google.js'
import { mapbox } from '../src/mapbox.js'
import type { Provider } from '../src/providers/types.js'
import { ok } from '../src/result.js'
import type { Place } from '../src/types.js'

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
