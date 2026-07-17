import { expect, test } from 'bun:test'
import { createGeocoder } from '../src/createGeocoder.js'
import { geocod } from '../src/geocod.js'
import { google } from '../src/google.js'
import {
	geocodAccuracy,
	googleAccuracy,
	mapboxAccuracy,
} from '../src/map/accuracy.js'
import { mapbox } from '../src/mapbox.js'
import type { Provider } from '../src/providers/types.js'
import { createRateLimiter } from '../src/rate-limit.js'
import { isEmptyQuery, isValidCoords, refinePlace } from '../src/refine.js'
import { err, ok } from '../src/result.js'
import type { Place } from '../src/types.js'

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
	expect(providers.map((p) => p.name)).toEqual(['mapbox', 'google', 'geocod'])
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
		{ getCoords: (x) => x.location },
	)
	expect(enriched.id).toBe(7)
	expect(enriched.address.error).toBe(null)

	const empty = await geo.geocode('')
	expect(empty.error).not.toBe(null)
	if (empty.error) expect(empty.error.code).toBe('BAD_REQUEST')
})
