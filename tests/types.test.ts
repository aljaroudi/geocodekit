import { expect, test } from 'bun:test'
import { createGeocoder } from '../src/createGeocoder.js'
import { geocod } from '../src/geocod.js'
import { google } from '../src/google.js'
import { mapbox } from '../src/mapbox.js'
import type { Provider } from '../src/providers/types.js'

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
