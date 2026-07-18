import type {
	AddressQuery,
	Coords,
	GeoResult,
	LookupOpts,
	Place,
	ProviderName,
	RateLimit,
} from '../types.js'

export type ApiKeyOptions = { apiKey: string }

export type ProviderRequestOpts = Pick<
	LookupOpts,
	'country' | 'language' | 'signal' | 'timeoutMs' | 'permanent'
>

export type Provider = {
	name: ProviderName
	defaultRateLimit: RateLimit
	geocode(
		query: AddressQuery,
		opts?: ProviderRequestOpts,
	): Promise<GeoResult<Place>>
	reverseGeocode(
		coords: Coords,
		opts?: ProviderRequestOpts,
	): Promise<GeoResult<Place>>
	geocodeBatch?(
		queries: AddressQuery[],
		opts?: ProviderRequestOpts,
	): Promise<GeoResult<Place>[]>
	reverseGeocodeBatch?(
		coords: Coords[],
		opts?: ProviderRequestOpts,
	): Promise<GeoResult<Place>[]>
}

export type BatchProvider = Provider & {
	geocodeBatch: NonNullable<Provider['geocodeBatch']>
	reverseGeocodeBatch: NonNullable<Provider['reverseGeocodeBatch']>
}
