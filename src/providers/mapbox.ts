import * as z from 'zod/mini'
import { safeFetch, safeJson } from '../fetch.js'
import { mapboxAccuracy } from '../map/accuracy.js'
import { isValidCoords } from '../refine.js'
import { err, ok } from '../result.js'
import type {
	AddressComponents,
	AddressQuery,
	Coords,
	GeoResult,
	Place,
} from '../types.js'
import type {
	ApiKeyOptions,
	BatchProvider,
	ProviderRequestOpts,
} from './types.js'

const featureSchema = z.object({
	type: z.optional(z.string()),
	id: z.optional(z.string()),
	geometry: z.optional(
		z.object({
			type: z.optional(z.string()),
			coordinates: z.optional(z.array(z.number())),
		}),
	),
	properties: z.optional(
		z.object({
			mapbox_id: z.optional(z.string()),
			feature_type: z.optional(z.string()),
			name: z.optional(z.string()),
			name_preferred: z.optional(z.string()),
			place_formatted: z.optional(z.string()),
			full_address: z.optional(z.string()),
			coordinates: z.optional(
				z.object({
					longitude: z.optional(z.number()),
					latitude: z.optional(z.number()),
					accuracy: z.optional(z.string()),
				}),
			),
			context: z.optional(z.record(z.string(), z.unknown())),
			address: z.optional(z.string()),
		}),
	),
})

const collectionSchema = z.object({
	type: z.optional(z.string()),
	features: z.optional(z.array(featureSchema)),
})

const batchSchema = z.object({
	batch: z.optional(z.array(collectionSchema)),
})

const positionSchema = z.tuple([z.number(), z.number()])
const geometrySchema = z.union([
	z.string(),
	z.object({
		type: z.literal('LineString'),
		coordinates: z.array(positionSchema),
	}),
])
const waypointSchema = z.object({
	name: z.string(),
	location: positionSchema,
	distance: z.optional(z.number()),
})
const maxspeedSchema = z.union([
	z.object({ speed: z.number(), unit: z.string() }),
	z.object({ unknown: z.literal(true) }),
])
const annotationSchema = z.object({
	distance: z.optional(z.array(z.number())),
	duration: z.optional(z.array(z.number())),
	speed: z.optional(z.array(z.number())),
	congestion: z.optional(z.array(z.string())),
	congestion_numeric: z.optional(z.array(z.number())),
	maxspeed: z.optional(z.array(maxspeedSchema)),
})
const maneuverSchema = z.object({
	type: z.string(),
	instruction: z.string(),
	location: positionSchema,
	bearing_before: z.optional(z.number()),
	bearing_after: z.optional(z.number()),
	modifier: z.optional(z.string()),
})
const stepSchema = z.object({
	distance: z.number(),
	duration: z.number(),
	weight: z.number(),
	name: z.string(),
	mode: z.string(),
	driving_side: z.string(),
	geometry: geometrySchema,
	maneuver: maneuverSchema,
})
const legSchema = z.object({
	summary: z.string(),
	distance: z.number(),
	duration: z.number(),
	weight: z.number(),
	steps: z.array(stepSchema),
	annotation: z.optional(annotationSchema),
})
const routeShape = {
	weight_name: z.string(),
	weight: z.number(),
	duration: z.number(),
	distance: z.number(),
	geometry: z.optional(geometrySchema),
	legs: z.array(legSchema),
	waypoints: z.optional(z.array(waypointSchema)),
}
const directionsSchema = z.object({
	code: z.literal('Ok'),
	routes: z.array(z.object(routeShape)),
	waypoints: z.optional(z.array(waypointSchema)),
	uuid: z.optional(z.string()),
})
const tracepointSchema = z.object({
	name: z.string(),
	location: positionSchema,
	distance: z.optional(z.number()),
	alternatives_count: z.optional(z.number()),
	waypoint_index: z.optional(z.nullable(z.number())),
	matchings_index: z.optional(z.number()),
})
const matchingSchema = z.object({
	code: z.literal('Ok'),
	matchings: z.array(
		z.object({
			...routeShape,
			weight_name: z.optional(z.string()),
			weight: z.optional(z.number()),
			confidence: z.number(),
		}),
	),
	tracepoints: z.array(z.nullable(tracepointSchema)),
})
const navigationErrorSchema = z.object({
	code: z.string(),
	message: z.optional(z.string()),
})
const optimizationStatusSchema = z.object({
	id: z.string(),
	status: z.union([
		z.literal('pending'),
		z.literal('processing'),
		z.literal('complete'),
		z.literal('ok'),
	]),
	status_date: z.optional(z.string()),
})
const optimizationStopSchema = z.object({
	type: z.string(),
	location: z.optional(z.string()),
	eta: z.string(),
	odometer: z.optional(z.number()),
	wait: z.optional(z.number()),
	duration: z.optional(z.number()),
	services: z.optional(z.array(z.string())),
	pickups: z.optional(z.array(z.string())),
	dropoffs: z.optional(z.array(z.string())),
})
const optimizationSolutionSchema = z.object({
	dropped: z.object({
		services: z.array(z.string()),
		shipments: z.array(z.string()),
	}),
	routes: z.array(
		z.object({
			vehicle: z.string(),
			stops: z.array(optimizationStopSchema),
		}),
	),
})

type Feature = z.infer<typeof featureSchema>

export type MapboxProfile =
	| 'driving'
	| 'driving-traffic'
	| 'walking'
	| 'cycling'
export type MapboxGeometryFormat = 'geojson' | 'polyline' | 'polyline6'
export type MapboxOverview = 'full' | 'simplified' | false
export type MapboxAnnotationType =
	| 'distance'
	| 'duration'
	| 'speed'
	| 'congestion'
	| 'congestion_numeric'
	| 'maxspeed'
export type MapboxApproach = 'curb' | 'unrestricted'
export type MapboxExclude =
	| 'motorway'
	| 'toll'
	| 'ferry'
	| 'unpaved'
	| 'cash_only_tolls'
	| 'country_border'
	| 'state_border'
	| 'tunnel'

export type MapboxNavigationOptions = {
	profile?: MapboxProfile
	annotations?: readonly MapboxAnnotationType[]
	approaches?: readonly (MapboxApproach | null)[]
	geometries?: MapboxGeometryFormat
	overview?: MapboxOverview
	radiuses?: readonly (number | 'unlimited' | null)[]
	steps?: boolean
	language?: string
	signal?: AbortSignal
	timeoutMs?: number
}

export type MapboxDirectionsOptions = MapboxNavigationOptions & {
	alternatives?: boolean
	bearings?: readonly (readonly [number, number] | null)[]
	exclude?: readonly MapboxExclude[]
	continueStraight?: boolean
	departAt?: string
	arriveBy?: string
}

export type MapboxMapMatchingOptions = Omit<
	MapboxNavigationOptions,
	'radiuses'
> & {
	radiuses?: readonly (number | null)[]
	timestamps?: readonly number[]
	tidy?: boolean
	waypoints?: readonly number[]
}

export type MapboxLineString = {
	type: 'LineString'
	coordinates: [number, number][]
}
export type MapboxGeometry = string | MapboxLineString
export type MapboxWaypoint = {
	name: string
	location: [number, number]
	distance?: number
}
export type MapboxAnnotation = {
	distance?: number[]
	duration?: number[]
	speed?: number[]
	congestion?: string[]
	congestion_numeric?: number[]
	maxspeed?: Array<{ speed: number; unit: string } | { unknown: true }>
}
export type MapboxManeuver = {
	type: string
	instruction: string
	location: [number, number]
	bearing_before?: number
	bearing_after?: number
	modifier?: string
}
export type MapboxRouteStep = {
	distance: number
	duration: number
	weight: number
	name: string
	mode: string
	driving_side: string
	geometry: MapboxGeometry
	maneuver: MapboxManeuver
}
export type MapboxRouteLeg = {
	summary: string
	distance: number
	duration: number
	weight: number
	steps: MapboxRouteStep[]
	annotation?: MapboxAnnotation
}
export type MapboxRoute = {
	weight_name: string
	weight: number
	duration: number
	distance: number
	geometry?: MapboxGeometry
	legs: MapboxRouteLeg[]
	waypoints?: MapboxWaypoint[]
}
export type MapboxDirectionsResponse = {
	code: 'Ok'
	routes: MapboxRoute[]
	waypoints?: MapboxWaypoint[]
	uuid?: string
}
export type MapboxTracepoint = MapboxWaypoint & {
	alternatives_count?: number
	waypoint_index?: number | null
	matchings_index?: number
}
export type MapboxMatching = Omit<MapboxRoute, 'weight' | 'weight_name'> & {
	weight?: number
	weight_name?: string
	confidence: number
}
export type MapboxMapMatchingResponse = {
	code: 'Ok'
	matchings: MapboxMatching[]
	tracepoints: (MapboxTracepoint | null)[]
}

export type MapboxOptimizationTimeWindow = {
	earliest: string
	latest: string
	type?: 'strict' | 'soft' | 'soft_start' | 'soft_end'
}
export type MapboxOptimizationBreak = {
	earliest_start: string
	latest_end: string
	duration: number
}
export type MapboxOptimizationLocation = {
	name: string
	coordinates: readonly [number, number]
}
export type MapboxOptimizationVehicle = {
	name: string
	routing_profile?: `mapbox/${MapboxProfile}`
	start_location?: string
	end_location?: string
	capacities?: Readonly<Record<string, number>>
	capabilities?: readonly string[]
	earliest_start?: string
	latest_end?: string
	breaks?: readonly MapboxOptimizationBreak[]
	loading_policy?: 'any' | 'fifo' | 'lifo'
}
export type MapboxOptimizationService = {
	name: string
	location: string
	duration?: number
	requirements?: readonly string[]
	service_times?: readonly MapboxOptimizationTimeWindow[]
}
export type MapboxOptimizationShipment = {
	name: string
	from: string
	to: string
	size?: Readonly<Record<string, number>>
	requirements?: readonly string[]
	pickup_duration?: number
	dropoff_duration?: number
	pickup_times?: readonly MapboxOptimizationTimeWindow[]
	dropoff_times?: readonly MapboxOptimizationTimeWindow[]
}
export type MapboxOptimizationOptions = {
	objectives?: readonly [
		'min-total-travel-duration' | 'min-schedule-completion-time',
	]
}
export type MapboxOptimizationProblem = {
	version: 1
	locations: readonly MapboxOptimizationLocation[]
	vehicles: readonly MapboxOptimizationVehicle[]
	services?: readonly MapboxOptimizationService[]
	shipments?: readonly MapboxOptimizationShipment[]
	options?: MapboxOptimizationOptions
}
export type MapboxOptimizationSubmission = {
	id: string
	status: 'pending' | 'processing' | 'complete' | 'ok'
	status_date?: string
}
export type MapboxOptimizationStop = {
	type: string
	location?: string
	eta: string
	odometer?: number
	wait?: number
	duration?: number
	services?: string[]
	pickups?: string[]
	dropoffs?: string[]
}
export type MapboxOptimizationRoute = {
	vehicle: string
	stops: MapboxOptimizationStop[]
}
export type MapboxOptimizationSolution = {
	dropped: { services: string[]; shipments: string[] }
	routes: MapboxOptimizationRoute[]
}
export type MapboxOptimizationPoll =
	| { complete: false }
	| { complete: true; solution: MapboxOptimizationSolution }
export type MapboxOptimizationRequestOptions = {
	signal?: AbortSignal
	timeoutMs?: number
}
export type MapboxOptimizeOptions = MapboxOptimizationRequestOptions & {
	pollIntervalMs?: number
	maxWaitMs?: number
}

export type MapboxClient = BatchProvider & {
	directions(
		coords: Coords[],
		opts?: MapboxDirectionsOptions,
	): Promise<GeoResult<MapboxDirectionsResponse>>
	mapMatch(
		coords: Coords[],
		opts?: MapboxMapMatchingOptions,
	): Promise<GeoResult<MapboxMapMatchingResponse>>
	submitOptimization(
		problem: MapboxOptimizationProblem,
		opts?: MapboxOptimizationRequestOptions,
	): Promise<GeoResult<MapboxOptimizationSubmission>>
	getOptimization(
		id: string,
		opts?: MapboxOptimizationRequestOptions,
	): Promise<GeoResult<MapboxOptimizationPoll>>
	listOptimizations(
		opts?: MapboxOptimizationRequestOptions,
	): Promise<GeoResult<MapboxOptimizationSubmission[]>>
	optimize(
		problem: MapboxOptimizationProblem,
		opts?: MapboxOptimizeOptions,
	): Promise<GeoResult<MapboxOptimizationSolution>>
}

function ctxField(
	ctx: Record<string, unknown> | undefined,
	key: string,
	field: string,
): string | undefined {
	const v = ctx?.[key]
	if (!v || typeof v !== 'object') return undefined
	const val = (v as Record<string, unknown>)[field]
	return typeof val === 'string' ? val : undefined
}

const STREETISH = new Set(['address', 'street', 'secondary_address'])

function featureToPlace(f: Feature): Place | null {
	const p = f.properties
	const geo = f.geometry?.coordinates
	const lng = geo?.[0]
	const lat = geo?.[1]
	const coords =
		p?.coordinates?.latitude != null && p?.coordinates?.longitude != null
			? { lat: p.coordinates.latitude, lng: p.coordinates.longitude }
			: typeof lat === 'number' && typeof lng === 'number'
				? { lat, lng }
				: null
	if (!coords) return null

	const ctx =
		p?.context && typeof p.context === 'object'
			? (p.context as Record<string, unknown>)
			: undefined
	const featureType = p?.feature_type
	const label = p?.name_preferred ?? p?.name
	const components: AddressComponents = {
		streetNumber:
			ctxField(ctx, 'address', 'address_number') ??
			(typeof p?.address === 'string' ? p.address : undefined),
		street:
			ctxField(ctx, 'street', 'name') ??
			ctxField(ctx, 'address', 'street_name'),
		unit: featureType === 'secondary_address' ? label : undefined,
		locality:
			ctxField(ctx, 'place', 'name') ?? ctxField(ctx, 'locality', 'name'),
		neighborhood: ctxField(ctx, 'neighborhood', 'name'),
		county: ctxField(ctx, 'district', 'name'),
		region: ctxField(ctx, 'region', 'name'),
		postcode: ctxField(ctx, 'postcode', 'name'),
		country: ctxField(ctx, 'country', 'name'),
		countryCode: ctxField(ctx, 'country', 'country_code')?.toUpperCase(),
	}

	const formatted =
		p?.full_address ??
		[label, p?.place_formatted].filter(Boolean).join(', ') ??
		`${coords.lat},${coords.lng}`

	return {
		formatted: formatted || `${coords.lat},${coords.lng}`,
		coordinates: coords,
		components,
		accuracy: mapboxAccuracy(p?.coordinates?.accuracy),
		provider: 'mapbox',
		id: p?.mapbox_id ?? f.id,
		name: featureType && !STREETISH.has(featureType) ? label : undefined,
	}
}

function parseCollection(json: unknown): GeoResult<Place> {
	const parsed = z.safeParse(collectionSchema, json)
	if (!parsed.success) {
		return err({
			code: 'BAD_RESPONSE',
			message: 'Invalid Mapbox response',
			provider: 'mapbox',
		})
	}
	const feature = parsed.data.features?.[0]
	if (!feature)
		return err({ code: 'NOT_FOUND', message: 'No results', provider: 'mapbox' })
	const place = featureToPlace(feature)
	if (!place)
		return err({
			code: 'BAD_RESPONSE',
			message: 'Missing coordinates',
			provider: 'mapbox',
		})
	return ok(place)
}

function structuredParams(q: Exclude<AddressQuery, string>): URLSearchParams {
	const p = new URLSearchParams()
	if (q.streetNumber) p.set('address_number', q.streetNumber)
	if (q.street) p.set('street', q.street)
	if (q.street2) p.set('address_line2', q.street2)
	if (q.locality) p.set('place', q.locality)
	if (q.region) p.set('region', q.region)
	if (q.postcode) p.set('postcode', q.postcode)
	if (q.country) p.set('country', q.country)
	return p
}

function forwardBody(
	q: AddressQuery,
	opts?: ProviderRequestOpts,
): Record<string, unknown> {
	const base: Record<string, unknown> = { types: 'address', limit: 1 }
	if (opts?.country) base.country = opts.country.toLowerCase()
	if (opts?.language) base.language = opts.language
	if (typeof q === 'string') {
		return { ...base, q }
	}
	return {
		...base,
		...(q.streetNumber ? { address_number: q.streetNumber } : {}),
		...(q.street ? { street: q.street } : {}),
		...(q.street2 ? { address_line2: q.street2 } : {}),
		...(q.locality ? { place: q.locality } : {}),
		...(q.region ? { region: q.region } : {}),
		...(q.postcode ? { postcode: q.postcode } : {}),
		...(q.country ? { country: q.country } : {}),
	}
}

const PROFILES = new Set<MapboxProfile>([
	'driving',
	'driving-traffic',
	'walking',
	'cycling',
])
const NOT_FOUND_CODES = new Set(['NoRoute', 'NoMatch', 'NoSegment'] as const)

function badRequest(message: string): GeoResult<never> {
	return err({ code: 'BAD_REQUEST', message, provider: 'mapbox' })
}

function validateNavigation(
	coords: Coords[],
	opts: MapboxNavigationOptions | undefined,
	max: number,
	aligned: readonly (readonly unknown[] | undefined)[],
): GeoResult<never> | null {
	if (coords.length < 2 || coords.length > max)
		return badRequest(`Expected 2-${max} coordinates`)
	if (!coords.every(isValidCoords)) return badRequest('Invalid coordinates')
	if (opts?.profile && !PROFILES.has(opts.profile))
		return badRequest('Invalid profile')
	if (aligned.some(values => values && values.length !== coords.length))
		return badRequest('Coordinate option lengths must match coordinates')
	return null
}

function setSharedParams(
	params: URLSearchParams,
	opts: MapboxNavigationOptions | undefined,
): void {
	if (opts?.annotations?.length)
		params.set('annotations', opts.annotations.join(','))
	if (opts?.approaches)
		params.set('approaches', opts.approaches.map(x => x ?? '').join(';'))
	if (opts?.geometries) params.set('geometries', opts.geometries)
	if (opts?.overview !== undefined)
		params.set('overview', String(opts.overview))
	if (opts?.radiuses)
		params.set('radiuses', opts.radiuses.map(x => x ?? '').join(';'))
	if (opts?.steps !== undefined) params.set('steps', String(opts.steps))
	if (opts?.language) params.set('language', opts.language)
}

function coordinatesPath(coords: Coords[]): string {
	return coords.map(({ lng, lat }) => `${lng},${lat}`).join(';')
}

function parseNavigation<T>(
	json: unknown,
	schema: z.ZodMiniType,
	label: string,
): GeoResult<T> {
	const apiError = z.safeParse(navigationErrorSchema, json)
	if (apiError.success && apiError.data.code !== 'Ok') {
		return err({
			code: NOT_FOUND_CODES.has(apiError.data.code)
				? 'NOT_FOUND'
				: 'BAD_REQUEST',
			message: apiError.data.message ?? apiError.data.code,
			provider: 'mapbox',
		})
	}
	if (!z.safeParse(schema, json).success) {
		return err({
			code: 'BAD_RESPONSE',
			message: `Invalid Mapbox ${label} response`,
			provider: 'mapbox',
		})
	}
	return ok(json as T)
}

function parseOptimization<T>(
	json: unknown,
	schema: z.ZodMiniType,
	label: string,
): GeoResult<T> {
	if (!z.safeParse(schema, json).success) {
		return err({
			code: 'BAD_RESPONSE',
			message: `Invalid Mapbox optimization ${label}`,
			provider: 'mapbox',
		})
	}
	return ok(json as T)
}

function validateOptimization(
	problem: MapboxOptimizationProblem,
): GeoResult<never> | null {
	if (!problem || typeof problem !== 'object' || problem.version !== 1)
		return badRequest('Optimization version must be 1')
	if (
		!Array.isArray(problem.locations) ||
		problem.locations.length < 1 ||
		problem.locations.length > 1000
	)
		return badRequest('Expected 1-1000 optimization locations')
	if (
		problem.locations.some(location => {
			const coordinates = location?.coordinates
			return (
				typeof location?.name !== 'string' ||
				!Array.isArray(coordinates) ||
				coordinates.length !== 2 ||
				!isValidCoords({ lng: coordinates[0], lat: coordinates[1] })
			)
		})
	)
		return badRequest('Invalid optimization locations')
	if (!Array.isArray(problem.vehicles) || problem.vehicles.length < 1)
		return badRequest('Expected at least one optimization vehicle')
	if (
		(!Array.isArray(problem.services) || problem.services.length === 0) &&
		(!Array.isArray(problem.shipments) || problem.shipments.length === 0)
	)
		return badRequest('Expected at least one service or shipment')
	return null
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve()
	return new Promise(resolve => {
		const done = () => {
			clearTimeout(timer)
			signal?.removeEventListener('abort', done)
			resolve()
		}
		const timer = setTimeout(done, ms)
		signal?.addEventListener('abort', done, { once: true })
	})
}

export type MapboxOptions = ApiKeyOptions

export function mapbox({ apiKey }: MapboxOptions): MapboxClient {
	async function geocode(
		query: AddressQuery,
		opts?: ProviderRequestOpts,
	): Promise<GeoResult<Place>> {
		const url = new URL('https://api.mapbox.com/search/geocode/v6/forward')
		url.searchParams.set('access_token', apiKey)
		url.searchParams.set('limit', '1')
		if (opts?.permanent) url.searchParams.set('permanent', 'true')
		if (opts?.country)
			url.searchParams.set('country', opts.country.toLowerCase())
		if (opts?.language) url.searchParams.set('language', opts.language)
		if (typeof query === 'string') {
			url.searchParams.set('q', query)
		} else {
			for (const [k, v] of structuredParams(query)) url.searchParams.set(k, v)
		}
		const json = await safeJson(url, {
			provider: 'mapbox',
			signal: opts?.signal,
			timeoutMs: opts?.timeoutMs,
		})
		if (json.error) return json
		return parseCollection(json.data)
	}

	async function reverseGeocode(
		coords: Coords,
		opts?: ProviderRequestOpts,
	): Promise<GeoResult<Place>> {
		const url = new URL('https://api.mapbox.com/search/geocode/v6/reverse')
		url.searchParams.set('access_token', apiKey)
		url.searchParams.set('longitude', String(coords.lng))
		url.searchParams.set('latitude', String(coords.lat))
		url.searchParams.set('limit', '1')
		if (opts?.permanent) url.searchParams.set('permanent', 'true')
		if (opts?.country)
			url.searchParams.set('country', opts.country.toLowerCase())
		if (opts?.language) url.searchParams.set('language', opts.language)
		const json = await safeJson(url, {
			provider: 'mapbox',
			signal: opts?.signal,
			timeoutMs: opts?.timeoutMs,
		})
		if (json.error) return json
		return parseCollection(json.data)
	}

	async function geocodeBatch(
		queries: AddressQuery[],
		opts?: ProviderRequestOpts,
	): Promise<GeoResult<Place>[]> {
		const json = await safeJson(
			`https://api.mapbox.com/search/geocode/v6/batch?access_token=${encodeURIComponent(apiKey)}${opts?.permanent ? '&permanent=true' : ''}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(queries.map(q => forwardBody(q, opts))),
				provider: 'mapbox',
				signal: opts?.signal,
				timeoutMs: opts?.timeoutMs,
			},
		)
		if (json.error) return queries.map(() => json)
		const parsed = z.safeParse(batchSchema, json.data)
		if (!parsed.success) {
			const e = err({
				code: 'BAD_RESPONSE',
				message: 'Invalid Mapbox batch response',
				provider: 'mapbox',
			})
			return queries.map(() => e)
		}
		const batch = parsed.data.batch ?? []
		return queries.map((_, i) => parseCollection(batch[i] ?? { features: [] }))
	}

	async function reverseGeocodeBatch(
		coordsList: Coords[],
		opts?: ProviderRequestOpts,
	): Promise<GeoResult<Place>[]> {
		const body = coordsList.map(c => ({
			longitude: c.lng,
			latitude: c.lat,
			limit: 1,
			...(opts?.country ? { country: opts.country.toLowerCase() } : {}),
			...(opts?.language ? { language: opts.language } : {}),
		}))
		const json = await safeJson(
			`https://api.mapbox.com/search/geocode/v6/batch?access_token=${encodeURIComponent(apiKey)}${opts?.permanent ? '&permanent=true' : ''}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				provider: 'mapbox',
				signal: opts?.signal,
				timeoutMs: opts?.timeoutMs,
			},
		)
		if (json.error) return coordsList.map(() => json)
		const parsed = z.safeParse(batchSchema, json.data)
		if (!parsed.success) {
			const e = err({
				code: 'BAD_RESPONSE',
				message: 'Invalid Mapbox batch response',
				provider: 'mapbox',
			})
			return coordsList.map(() => e)
		}
		const batch = parsed.data.batch ?? []
		return coordsList.map((_, i) =>
			parseCollection(batch[i] ?? { features: [] }),
		)
	}

	async function directions(
		coords: Coords[],
		opts?: MapboxDirectionsOptions,
	): Promise<GeoResult<MapboxDirectionsResponse>> {
		const invalid = validateNavigation(coords, opts, 25, [
			opts?.radiuses,
			opts?.approaches,
			opts?.bearings,
		])
		if (invalid) return invalid
		if (
			opts?.radiuses?.some(
				x => x !== null && x !== 'unlimited' && (!Number.isFinite(x) || x <= 0),
			)
		)
			return badRequest('Invalid radiuses')
		if (
			opts?.bearings?.some(
				x =>
					x !== null &&
					(!Number.isFinite(x[0]) ||
						x[0] < 0 ||
						x[0] > 360 ||
						!Number.isFinite(x[1]) ||
						x[1] < 0 ||
						x[1] > 180),
			)
		)
			return badRequest('Invalid bearings')

		const profile = opts?.profile ?? 'driving'
		const url = new URL(
			`https://api.mapbox.com/directions/v5/mapbox/${profile}/${coordinatesPath(coords)}`,
		)
		url.searchParams.set('access_token', apiKey)
		setSharedParams(url.searchParams, opts)
		if (opts?.alternatives !== undefined)
			url.searchParams.set('alternatives', String(opts.alternatives))
		if (opts?.bearings)
			url.searchParams.set(
				'bearings',
				opts.bearings.map(x => (x ? x.join(',') : '')).join(';'),
			)
		if (opts?.exclude?.length)
			url.searchParams.set('exclude', opts.exclude.join(','))
		if (opts?.continueStraight !== undefined)
			url.searchParams.set('continue_straight', String(opts.continueStraight))
		if (opts?.departAt) url.searchParams.set('depart_at', opts.departAt)
		if (opts?.arriveBy) url.searchParams.set('arrive_by', opts.arriveBy)

		const json = await safeJson(url, {
			provider: 'mapbox',
			signal: opts?.signal,
			timeoutMs: opts?.timeoutMs,
		})
		if (json.error) return json
		return parseNavigation(json.data, directionsSchema, 'directions')
	}

	async function mapMatch(
		coords: Coords[],
		opts?: MapboxMapMatchingOptions,
	): Promise<GeoResult<MapboxMapMatchingResponse>> {
		const invalid = validateNavigation(coords, opts, 100, [
			opts?.radiuses,
			opts?.timestamps,
		])
		if (invalid) return invalid
		if (
			opts?.approaches &&
			opts.approaches.length !== (opts.waypoints?.length ?? coords.length)
		)
			return badRequest('Approaches length must match waypoints')
		if (
			opts?.radiuses?.some(
				x => x !== null && (!Number.isFinite(x) || x < 0 || x > 50),
			)
		)
			return badRequest('Invalid radiuses')
		if (
			opts?.timestamps?.some(
				(x, i, all) =>
					!Number.isInteger(x) || x < 0 || (i > 0 && x <= (all[i - 1] ?? -1)),
			)
		)
			return badRequest('Invalid timestamps')
		if (
			opts?.waypoints &&
			(opts.waypoints.length < 2 ||
				opts.waypoints[0] !== 0 ||
				opts.waypoints.at(-1) !== coords.length - 1 ||
				opts.waypoints.some(
					(x, i, all) =>
						!Number.isInteger(x) ||
						x < 0 ||
						x >= coords.length ||
						(i > 0 && x <= (all[i - 1] ?? -1)),
				))
		)
			return badRequest('Invalid waypoints')

		const profile = opts?.profile ?? 'driving'
		const url = new URL(
			`https://api.mapbox.com/matching/v5/mapbox/${profile}/${coordinatesPath(coords)}.json`,
		)
		url.searchParams.set('access_token', apiKey)
		setSharedParams(url.searchParams, opts)
		if (opts?.timestamps)
			url.searchParams.set('timestamps', opts.timestamps.join(';'))
		if (opts?.tidy !== undefined)
			url.searchParams.set('tidy', String(opts.tidy))
		if (opts?.waypoints)
			url.searchParams.set('waypoints', opts.waypoints.join(';'))

		const json = await safeJson(url, {
			provider: 'mapbox',
			signal: opts?.signal,
			timeoutMs: opts?.timeoutMs,
		})
		if (json.error) return json
		return parseNavigation(json.data, matchingSchema, 'map matching')
	}

	async function submitOptimization(
		problem: MapboxOptimizationProblem,
		opts?: MapboxOptimizationRequestOptions,
	): Promise<GeoResult<MapboxOptimizationSubmission>> {
		const invalid = validateOptimization(problem)
		if (invalid) return invalid
		let body: string
		try {
			body = JSON.stringify(problem)
		} catch {
			return badRequest('Optimization problem must be JSON serializable')
		}
		const url = new URL('https://api.mapbox.com/optimized-trips/v2')
		url.searchParams.set('access_token', apiKey)
		const json = await safeJson(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
			provider: 'mapbox',
			signal: opts?.signal,
			timeoutMs: opts?.timeoutMs,
		})
		if (json.error) return json
		return parseOptimization(
			json.data,
			optimizationStatusSchema,
			'submission response',
		)
	}

	async function getOptimization(
		id: string,
		opts?: MapboxOptimizationRequestOptions,
	): Promise<GeoResult<MapboxOptimizationPoll>> {
		if (typeof id !== 'string' || !id.trim())
			return badRequest('Optimization id is required')
		const url = new URL(
			`https://api.mapbox.com/optimized-trips/v2/${encodeURIComponent(id)}`,
		)
		url.searchParams.set('access_token', apiKey)
		const response = await safeFetch(url, {
			provider: 'mapbox',
			signal: opts?.signal,
			timeoutMs: opts?.timeoutMs,
		})
		if (response.error) {
			if (response.error.status === 404)
				return err({ ...response.error, code: 'NOT_FOUND' })
			return response
		}
		if (response.data.status === 202) return ok({ complete: false })
		if (response.data.status !== 200)
			return err({
				code: 'BAD_RESPONSE',
				message: `Unexpected Mapbox optimization HTTP ${response.data.status}`,
				provider: 'mapbox',
				status: response.data.status,
			})
		let json: unknown
		try {
			json = await response.data.json()
		} catch {
			return err({
				code: 'BAD_RESPONSE',
				message: 'Invalid Mapbox optimization solution JSON',
				provider: 'mapbox',
			})
		}
		const solution = parseOptimization<MapboxOptimizationSolution>(
			json,
			optimizationSolutionSchema,
			'solution response',
		)
		return solution.error
			? solution
			: ok({ complete: true, solution: solution.data })
	}

	async function listOptimizations(
		opts?: MapboxOptimizationRequestOptions,
	): Promise<GeoResult<MapboxOptimizationSubmission[]>> {
		const url = new URL('https://api.mapbox.com/optimized-trips/v2')
		url.searchParams.set('access_token', apiKey)
		const json = await safeJson(url, {
			provider: 'mapbox',
			signal: opts?.signal,
			timeoutMs: opts?.timeoutMs,
		})
		if (json.error) return json
		return parseOptimization(
			json.data,
			z.array(optimizationStatusSchema),
			'submissions response',
		)
	}

	async function optimize(
		problem: MapboxOptimizationProblem,
		opts?: MapboxOptimizeOptions,
	): Promise<GeoResult<MapboxOptimizationSolution>> {
		const pollIntervalMs = opts?.pollIntervalMs ?? 1000
		if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1000)
			return badRequest('pollIntervalMs must be at least 1000')
		if (
			opts?.maxWaitMs !== undefined &&
			(!Number.isFinite(opts.maxWaitMs) || opts.maxWaitMs <= 0)
		)
			return badRequest('maxWaitMs must be positive')

		const deadline =
			opts?.maxWaitMs === undefined ? undefined : Date.now() + opts.maxWaitMs
		const requestOpts = (): MapboxOptimizationRequestOptions => {
			const remaining =
				deadline === undefined ? undefined : Math.max(1, deadline - Date.now())
			const timeoutMs =
				remaining === undefined
					? opts?.timeoutMs
					: opts?.timeoutMs == null || opts.timeoutMs <= 0
						? remaining
						: Math.min(opts.timeoutMs, remaining)
			return { signal: opts?.signal, timeoutMs }
		}

		const submission = await submitOptimization(problem, requestOpts())
		if (submission.error) return submission
		for (;;) {
			if (deadline !== undefined && Date.now() >= deadline)
				return err({
					code: 'TIMEOUT',
					message: 'Mapbox optimization timed out',
					provider: 'mapbox',
				})
			const poll = await getOptimization(submission.data.id, requestOpts())
			if (poll.error) return poll
			if (poll.data.complete) return ok(poll.data.solution)
			const remaining =
				deadline === undefined ? pollIntervalMs : deadline - Date.now()
			await wait(Math.min(pollIntervalMs, Math.max(0, remaining)), opts?.signal)
		}
	}

	return {
		name: 'mapbox',
		defaultRateLimit: { maxPerMinute: 1000 },
		geocode,
		reverseGeocode,
		geocodeBatch,
		reverseGeocodeBatch,
		directions,
		mapMatch,
		submitOptimization,
		getOptimization,
		listOptimizations,
		optimize,
	}
}
