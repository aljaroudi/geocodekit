import type { GeoError, GeoResult } from './types.js'

export function ok<T>(data: T): GeoResult<T> {
	return { data, error: null }
}

export function err(error: GeoError): GeoResult<never> {
	return { data: null, error }
}
