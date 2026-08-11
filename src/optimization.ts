import type { Provider } from './providers/types.js'
import { isValidCoords } from './refine.js'
import { err, ok } from './result.js'
import type { Coords, GeoResult, ProviderName } from './types.js'

export type OptimizationStop = {
	id: string
	coordinates: Coords
}

export type OptimizationProblem = {
	stops: readonly OptimizationStop[]
	start?: Coords
	end?: Coords
}

export type OptimizationSolution = {
	order: string[]
	dropped: string[]
	path?: [lng: number, lat: number][]
}

export type OptimizeOptions = {
	signal?: AbortSignal
	timeoutMs?: number
}

export type OptimizationProvider = Provider & {
	optimize(
		problem: OptimizationProblem,
		opts?: OptimizeOptions,
	): Promise<GeoResult<OptimizationSolution>>
}

export function validateOptimizationProblem(
	problem: OptimizationProblem,
	opts: OptimizeOptions | undefined,
	provider: ProviderName,
): GeoResult<never> | null {
	if (
		!problem ||
		typeof problem !== 'object' ||
		!Array.isArray(problem.stops) ||
		problem.stops.length < 2 ||
		problem.stops.length > 1000
	)
		return err({
			code: 'BAD_REQUEST',
			message: 'Expected 2-1000 optimization stops',
			provider,
		})

	const ids = new Set<string>()
	for (const stop of problem.stops) {
		if (
			!stop ||
			typeof stop.id !== 'string' ||
			!stop.id.trim() ||
			ids.has(stop.id) ||
			!isValidCoords(stop.coordinates)
		)
			return err({
				code: 'BAD_REQUEST',
				message: 'Optimization stops need unique ids and valid coordinates',
				provider,
			})
		ids.add(stop.id)
	}

	if (
		(problem.start !== undefined && !isValidCoords(problem.start)) ||
		(problem.end !== undefined && !isValidCoords(problem.end))
	)
		return err({
			code: 'BAD_REQUEST',
			message: 'Invalid optimization start or end coordinates',
			provider,
		})

	if (
		opts?.timeoutMs !== undefined &&
		(!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)
	)
		return err({
			code: 'BAD_REQUEST',
			message: 'timeoutMs must be positive',
			provider,
		})

	return null
}

export function normalizeOptimizationSolution(
	problem: OptimizationProblem,
	order: string[],
	dropped: string[],
	provider: ProviderName,
	path?: [lng: number, lat: number][],
): GeoResult<OptimizationSolution> {
	const expected = new Set(problem.stops.map(stop => stop.id))
	const returned = [...order, ...dropped]
	if (
		returned.length !== expected.size ||
		new Set(returned).size !== returned.length ||
		returned.some(id => !expected.has(id))
	)
		return err({
			code: 'BAD_RESPONSE',
			message: `Invalid ${provider} optimization stop order`,
			provider,
		})
	return ok({ order, dropped, ...(path ? { path } : {}) })
}
