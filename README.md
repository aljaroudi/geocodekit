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
    mapbox({ apiKey: process.env.MAPBOX_TOKEN! }),
    google({ apiKey: process.env.GOOGLE_MAPS_KEY! }),
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
  { getCoords: (x) => x.location },
)
```

### Fallback

Default: try next provider on any error except `BAD_REQUEST` and `ABORTED`.

```ts
createGeocoder({
  providers: […],
  shouldFallback: (e) => e.code === 'RATE_LIMIT' || e.code === 'NETWORK',
})
```

## License

MIT
