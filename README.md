# geocodekit

Type-safe geocode / reverse-geocode universal helper that **never throws**.

## Install

```bash
npm install geocodekit
# or
bun add geocodekit
```

## Quick start

```ts
import { createGeocoder } from 'geocodekit'
import { mapbox } from 'geocodekit/mapbox'
import { google } from 'geocodekit/google'

const geo = createGeocoder({
  providers: [
    mapbox({ apiKey: MAPBOX_TOKEN }),
    google({ apiKey: GOOGLE_MAPS_KEY }),
  ],
})

const { data, error } = await geo.geocode('1600 Amphitheatre Parkway, Mountain View, CA')
if (error) {
  console.log(error.code, error.message)
} else {
  console.log(data.formatted, data.coordinates)
}
```

Import only the providers you use (`geocodekit/mapbox`, `geocodekit/google`, `geocodekit/geocod`) so unused adapters tree-shake away.

## API

### `geocode` / `reverseGeocode`

Scalar or array. Arrays return **per-item** `GeoResult`s.

```ts
await geo.geocode('Berlin')
await geo.geocode(['Berlin', 'Paris'], {
  mode: 'auto', // batch if provider supports it, else paced loop
  rateLimit: { maxPerMinute: 500 }, // defaults to provider's rate limit
  concurrency: 2, // defaults to 1
})

await geo.reverseGeocode({ lat: 52.52, lng: 13.405 })
```

Structured input:

```ts
await geo.geocode({
  streetNumber: '1600',
  street: 'Amphitheatre Parkway',
  locality: 'Mountain View',
  region: 'CA',
  country: 'US',
})
```

### Options that narrow types

- `require: ['street', 'county', 'name', …]`: missing fields → `MISSING_FIELDS`; success narrows those keys on `Place` / `components`
- `minAccuracy: 'rooftop'`: too coarse → `LOW_ACCURACY`; success narrows `accuracy`

`name` is the place / POI / addressee label (Geocod `addressee`, Mapbox non-address feature labels). Google Geocoding often omits it. New components: `unit`, `neighborhood`, `county`.

### `withAddress`

```ts
const pin = { id: 1, lat: 40.7, lng: -74 }
const out = await geo.withAddress(pin)
// out.address: GeoResult<Place>

const nested = await geo.withAddress(
  { id: 1, location: { lat: 40.7, lng: -74 } },
  { getCoords: x => x.location },
)
```

### Mapbox navigation

Mapbox client also exposes Mapbox-only navigation APIs. Profile defaults to `driving`.

```ts
const mapboxClient = mapbox({ apiKey: MAPBOX_TOKEN })

const route = await mapboxClient.directions(
  [{ lat: 24.7136, lng: 46.6753 }, { lat: 21.4858, lng: 39.1925 }],
  { profile: 'driving-traffic', geometries: 'geojson', steps: true },
)

const match = await mapboxClient.mapMatch(gpsTrace, {
  timestamps,
  tidy: true,
  geometries: 'geojson',
})
```

### Route optimization

Mapbox and Google clients share one single-vehicle API. Stops use normal `{ lat, lng }` coordinates; results contain the optimized stop ids and any dropped ids.

```ts
import { GoogleAuth } from 'google-auth-library'

const problem = {
  stops: [
    { id: 'a', coordinates: { lat: 24.7136, lng: 46.6753 } },
    { id: 'b', coordinates: { lat: 24.72, lng: 46.7 } },
  ],
  start: { lat: 24.7, lng: 46.6 }, // optional fixed start
  end: { lat: 24.8, lng: 46.8 },   // optional fixed end
}

const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
})
const googleClient = google({
  apiKey: GOOGLE_MAPS_KEY, // geocoding only
  projectId: GOOGLE_CLOUD_PROJECT,
  getOptimizationHeaders: () => auth.getRequestHeaders(),
})
const result = await googleClient.optimize(problem, { timeoutMs: 60_000 })
if (!result.error) console.log(result.data.order, result.data.dropped)

// Same problem and result types. Mapbox Optimization v2 access is required.
await mapboxClient.optimize(problem, { timeoutMs: 60_000 })
```

Your app owns `google-auth-library` and its ADC or service-account setup; geocodekit requests fresh OAuth headers for every optimization. Enable Google's Route Optimization API and billing for `projectId`. The normalized API supports 2–1,000 stops, one driving vehicle, and optional fixed start/end points. See [Google Route Optimization](https://developers.google.com/maps/documentation/route-optimization/overview), [authentication](https://developers.google.com/maps/documentation/route-optimization/cloud-setup), [timeouts](https://developers.google.com/maps/documentation/route-optimization/timeouts), and [usage and billing](https://developers.google.com/maps/documentation/route-optimization/usage-and-billing).

Mapbox Optimization v2 is beta and requires account access. Use `optimizeV2` when the full Mapbox wire format is needed, including multiple vehicles, services, or shipments.

```ts
const problem = {
  version: 1,
  locations: [
    { name: 'warehouse', coordinates: [46.6753, 24.7136] },
    { name: 'customer', coordinates: [46.7, 24.72] },
  ],
  vehicles: [{
    name: 'truck-1',
    start_location: 'warehouse',
    end_location: 'warehouse',
  }],
  services: [{ name: 'delivery-1', location: 'customer' }],
} as const

// Submit and poll until complete (at most 60 status requests/minute).
const solution = await mapboxClient.optimizeV2(problem, { maxWaitMs: 60_000 })

// Or control the asynchronous lifecycle yourself.
const submission = await mapboxClient.submitOptimization(problem)
if (!submission.error) {
  const progress = await mapboxClient.getOptimization(submission.data.id)
  const submissions = await mapboxClient.listOptimizations()
}
```

See [Optimization v2 documentation](https://docs.mapbox.com/api/navigation/optimization/) and [current pricing](https://www.mapbox.com/pricing).

### Fallback

Default: try next provider on any error except `BAD_REQUEST` and `ABORTED`.

```ts
createGeocoder({
  providers: […],
  shouldFallback: e => e.code === 'RATE_LIMIT' || e.code === 'NETWORK',
})
```

## License

MIT
