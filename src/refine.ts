import { err, ok } from './result.js'
import type { GeoResult, ProviderName } from './types.js'
import {
	ACCURACY_RANK,
	type Accuracy,
	type Place,
	type RequireKey,
} from './types.js'

export function meetsAccuracy(place: Place, min: Accuracy): boolean {
	return ACCURACY_RANK[place.accuracy] >= ACCURACY_RANK[min]
}

function isBlank(v: string | undefined): boolean {
	return v == null || v === ''
}

/** Keys from `require` that are empty on this place. */
export function missingRequired(
	place: Place,
	require: readonly RequireKey[],
): RequireKey[] {
	return require.filter((k) => {
		if (k === 'name') return isBlank(place.name)
		return isBlank(place.components[k])
	})
}

/** Apply minAccuracy + require after a successful Place. */
export function refinePlace(
	place: Place,
	opts: { minAccuracy?: Accuracy; require?: readonly RequireKey[] },
	provider?: ProviderName,
): GeoResult<Place> {
	if (opts.minAccuracy && !meetsAccuracy(place, opts.minAccuracy)) {
		return err({
			code: 'LOW_ACCURACY',
			message: `Accuracy ${place.accuracy} below min ${opts.minAccuracy}`,
			provider: provider ?? place.provider,
			accuracy: place.accuracy,
		})
	}
	if (opts.require?.length) {
		const missing = missingRequired(place, opts.require)
		if (missing.length) {
			return err({
				code: 'MISSING_FIELDS',
				message: `Missing required fields: ${missing.join(', ')}`,
				provider: provider ?? place.provider,
				missing,
			})
		}
	}
	return ok(place)
}

export function isEmptyQuery(q: unknown): boolean {
	if (typeof q === 'string') return q.trim() === ''
	if (q && typeof q === 'object') {
		return !Object.values(q as Record<string, unknown>).some(
			(v) => typeof v === 'string' && v.trim() !== '',
		)
	}
	return true
}

export function isValidCoords(c: { lat?: unknown; lng?: unknown }): boolean {
	return (
		typeof c.lat === 'number' &&
		typeof c.lng === 'number' &&
		Number.isFinite(c.lat) &&
		Number.isFinite(c.lng) &&
		c.lat >= -90 &&
		c.lat <= 90 &&
		c.lng >= -180 &&
		c.lng <= 180
	)
}
