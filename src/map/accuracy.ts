import type { Accuracy } from '../types.js'

export function mapboxAccuracy(raw: string | undefined): Accuracy {
	switch (raw) {
		case 'rooftop':
			return 'rooftop'
		case 'parcel':
			return 'parcel'
		case 'point':
			return 'point'
		case 'interpolated':
			return 'interpolated'
		case 'approximate':
		case 'intersection':
		case 'street':
			return 'approximate'
		default:
			return 'unknown'
	}
}

export function googleAccuracy(raw: string | undefined): Accuracy {
	switch (raw) {
		case 'ROOFTOP':
			return 'rooftop'
		case 'RANGE_INTERPOLATED':
			return 'interpolated'
		case 'GEOMETRIC_CENTER':
			return 'point'
		case 'APPROXIMATE':
			return 'approximate'
		default:
			return 'unknown'
	}
}

export function geocodAccuracy(raw: string | undefined): Accuracy {
	switch (raw) {
		case 'rooftop':
			return 'rooftop'
		case 'point':
			return 'point'
		case 'range_interpolation':
			return 'interpolated'
		case 'nearest_rooftop_match':
			return 'parcel'
		case 'intersection':
		case 'street_center':
		case 'place':
		case 'county':
		case 'state':
		case 'nearest_street':
		case 'nearest_place':
			return 'approximate'
		default:
			return 'unknown'
	}
}
