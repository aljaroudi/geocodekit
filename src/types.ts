export type ProviderName = 'mapbox' | 'google' | 'geocod'

/** WGS84 latitude / longitude. */
export type Coords = { lat: number; lng: number }

/**
 * Structured address parts. All optional — use `require` to demand and narrow.
 *
 * Provider coverage varies; missing keys stay `undefined` rather than guessed.
 */
export type AddressComponents = {
	/** House / building number. Google `street_number`, Mapbox address number, Geocod `number`. */
	streetNumber?: string
	/** Street / route name. Google `route`, Mapbox street context, Geocod `formatted_street`. */
	street?: string
	/** Suite, apt, unit, or secondary line. Google `subpremise`, Mapbox secondary, Geocod `street2`. */
	unit?: string
	/** City / town. Google `locality`, Mapbox `place`, Geocod `city`. */
	locality?: string
	/** Neighborhood or colloquial area. Google `neighborhood`, Mapbox `context.neighborhood`. */
	neighborhood?: string
	/** County / admin level 2 / district. Google `administrative_area_level_2`, Mapbox `district`, Geocod `county`. */
	county?: string
	/** State / province / admin level 1. */
	region?: string
	/** Postal / ZIP code. */
	postcode?: string
	/** Country display name (or ISO code when that is all the provider returns). */
	country?: string
	/** ISO 3166-1 alpha-2 country code when available. */
	countryCode?: string
}

export type ComponentKey = keyof AddressComponents

/**
 * Keys allowed in {@link LookupOpts.require}: any {@link ComponentKey}, plus
 * selected top-level {@link Place} fields (`name`).
 *
 * Required keys narrow the success type via {@link PlaceNarrowed}; missing ones
 * yield `MISSING_FIELDS` (and trigger provider fallback by default).
 *
 * @example
 * ```ts
 * const { data, error } = await geo.geocode(q, {
 *   require: ['street', 'locality', 'name'],
 * })
 * if (!error) {
 *   data.name // string
 *   data.components.street // string
 * }
 * ```
 */
export type RequireKey = ComponentKey | 'name'

/** Ordered coarsest → finest for minAccuracy checks. */
export type Accuracy =
	| 'unknown'
	| 'approximate'
	| 'interpolated'
	| 'point'
	| 'parcel'
	| 'rooftop'

export const ACCURACY_RANK: Record<Accuracy, number> = {
	unknown: 0,
	approximate: 1,
	interpolated: 2,
	point: 3,
	parcel: 4,
	rooftop: 5,
}

/**
 * Normalized geocode / reverse-geocode hit from any provider.
 *
 * @example
 * ```ts
 * const { data, error } = await geo.geocode(q, { require: ['name'] })
 * if (!error) data.name // string — narrowed by require
 * ```
 */
export type Place = {
	/** Full display address from the provider. */
	formatted: string
	coordinates: Coords
	components: AddressComponents
	accuracy: Accuracy
	provider: ProviderName
	/** Provider place id (Google `place_id`, Mapbox `mapbox_id`, Geocod `stable_address_key`). */
	id?: string
	/**
	 * Place / POI / addressee name when the provider returns one (not the street line).
	 * Geocod: `addressee`. Mapbox: feature label when not an address/street.
	 * Often absent on Google Geocoding (no dedicated name field).
	 */
	name?: string
}

export type AddressQuery =
	| string
	| {
			street?: string
			street2?: string
			streetNumber?: string
			locality?: string
			region?: string
			postcode?: string
			country?: string
	  }

export type GeoErrorCode =
	| 'BAD_REQUEST'
	| 'NOT_FOUND'
	| 'LOW_ACCURACY'
	| 'MISSING_FIELDS'
	| 'RATE_LIMIT'
	| 'AUTH'
	| 'NETWORK'
	| 'TIMEOUT'
	| 'ABORTED'
	| 'BAD_RESPONSE'
	| 'PROVIDER_DOWN'

export type GeoError = {
	code: GeoErrorCode
	message: string
	provider?: ProviderName
	/** Keys from `require` that were empty after a successful provider hit. */
	missing?: RequireKey[]
	status?: number
	accuracy?: Accuracy
}

export type GeoResult<T> =
	| { data: T; error: null }
	| { data: null; error: GeoError }

export type RateLimit = { maxPerMinute: number }

export type ArrayMode = 'auto' | 'batch' | 'sequential'

export type LookupOptsBase = {
	/**
	 * Demand these fields on success. Missing → `MISSING_FIELDS`.
	 * Narrows {@link PlaceNarrowed} so required keys are non-optional.
	 */
	require?: readonly RequireKey[]
	/** Reject results coarser than this; success narrows {@link Place.accuracy}. */
	minAccuracy?: Accuracy
	country?: string
	language?: string
	signal?: AbortSignal
	timeoutMs?: number
	/**
	 * Mapbox only: `true` grants rights to store/cache results (billed higher).
	 * Default `false` (temporary, no caching). Ignored by providers without a storage flag.
	 */
	permanent?: boolean
	mode?: ArrayMode
	rateLimit?: RateLimit
	concurrency?: number
}

export type LookupOpts<
	R extends RequireKey = never,
	A extends Accuracy = Accuracy,
> = Omit<LookupOptsBase, 'require' | 'minAccuracy'> & {
	require?: readonly R[]
	minAccuracy?: A
}

export type WithAddressOpts<
	T,
	R extends RequireKey = never,
	A extends Accuracy = Accuracy,
> = LookupOpts<R, A> & {
	getCoords?: (item: T) => Coords
}

export type AccuracyFloor<A extends Accuracy> = A extends 'rooftop'
	? 'rooftop'
	: A extends 'parcel'
		? 'rooftop' | 'parcel'
		: A extends 'point'
			? 'rooftop' | 'parcel' | 'point'
			: A extends 'interpolated'
				? 'rooftop' | 'parcel' | 'point' | 'interpolated'
				: A extends 'approximate'
					? 'rooftop' | 'parcel' | 'point' | 'interpolated' | 'approximate'
					: Accuracy

/** {@link Place} after `require` / `minAccuracy` have been applied at the type level. */
export type PlaceNarrowed<
	R extends RequireKey = never,
	A extends Accuracy = Accuracy,
> = Omit<Place, 'components' | 'accuracy' | 'name'> & {
	accuracy: Accuracy extends A ? Accuracy : AccuracyFloor<A>
	components: [Extract<R, ComponentKey>] extends [never]
		? AddressComponents
		: AddressComponents &
				Required<Pick<AddressComponents, Extract<R, ComponentKey>>>
} & ('name' extends R ? { name: string } : { name?: string })
