export type ProviderName = 'mapbox' | 'google' | 'geocod'

export type Coords = { lat: number; lng: number }

export type AddressComponents = {
	streetNumber?: string
	street?: string
	locality?: string
	region?: string
	postcode?: string
	country?: string
	countryCode?: string
}

export type ComponentKey = keyof AddressComponents

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

export type Place = {
	formatted: string
	coordinates: Coords
	components: AddressComponents
	accuracy: Accuracy
	provider: ProviderName
	id?: string
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
	missing?: ComponentKey[]
	status?: number
	accuracy?: Accuracy
}

export type GeoResult<T> =
	| { data: T; error: null }
	| { data: null; error: GeoError }

export type RateLimit = { maxPerMinute: number }

export type ArrayMode = 'auto' | 'batch' | 'sequential'

export type LookupOptsBase = {
	require?: readonly ComponentKey[]
	minAccuracy?: Accuracy
	country?: string
	language?: string
	signal?: AbortSignal
	timeoutMs?: number
	mode?: ArrayMode
	rateLimit?: RateLimit
	concurrency?: number
}

export type LookupOpts<
	R extends ComponentKey = never,
	A extends Accuracy = Accuracy,
> = Omit<LookupOptsBase, 'require' | 'minAccuracy'> & {
	require?: readonly R[]
	minAccuracy?: A
}

export type WithAddressOpts<
	T,
	R extends ComponentKey = never,
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

export type PlaceNarrowed<
	R extends ComponentKey = never,
	A extends Accuracy = Accuracy,
> = Omit<Place, 'components' | 'accuracy'> & {
	accuracy: Accuracy extends A ? Accuracy : AccuracyFloor<A>
	components: [R] extends [never]
		? AddressComponents
		: AddressComponents & Required<Pick<AddressComponents, R>>
}
