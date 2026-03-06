import type {
  DCPEffectivePressureBand,
  DCPPressureBand,
  DCPPressureState,
  DCPStrategyName,
} from './types'

const PRESSURE_RANK: Record<DCPPressureBand, number> = {
  unknown: -1,
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
}

const STRATEGY_MINIMUM_BAND: Record<DCPStrategyName, DCPEffectivePressureBand> =
  {
    deduplicate: 'low',
    purgeErrors: 'low',
    outputBodyReplace: 'low',
    supersedeWrites: 'high',
  }

export function getEffectivePressureBand(
  band: DCPPressureBand
): DCPEffectivePressureBand {
  return band === 'unknown' ? 'low' : band
}

export function getStrategyMinimumBand(
  strategy: DCPStrategyName
): DCPEffectivePressureBand {
  return STRATEGY_MINIMUM_BAND[strategy]
}

export function isPressureBandAtLeast(
  band: DCPPressureBand,
  minimumBand: DCPEffectivePressureBand
): boolean {
  return (
    PRESSURE_RANK[getEffectivePressureBand(band)] >= PRESSURE_RANK[minimumBand]
  )
}

export function isStrategyEnabledForPressure(
  strategy: DCPStrategyName,
  pressure: Pick<DCPPressureState, 'band'>
): boolean {
  return isPressureBandAtLeast(pressure.band, STRATEGY_MINIMUM_BAND[strategy])
}

export function describeEffectivePressureBand(band: DCPPressureBand): string {
  const effectiveBand = getEffectivePressureBand(band)

  switch (effectiveBand) {
    case 'low':
      return band === 'unknown'
        ? 'baseline safe wins active; ctx.getContextUsage unavailable so low-band defaults stay on'
        : 'baseline safe wins active; large-output replacement active'
    case 'medium':
      return 'baseline safe wins active; no extra high-pressure pruning yet'
    case 'high':
      return 'broader stale payload pruning active'
    case 'critical':
      return 'broader stale payload pruning active; compaction preferred, so prefer compaction coordination when available'
  }
}

export function describePressureFooterLabel(band: DCPPressureBand): string {
  const effectiveBand = getEffectivePressureBand(band)

  switch (effectiveBand) {
    case 'low':
      return band === 'unknown' ? 'low default policy' : 'baseline safe wins'
    case 'medium':
      return 'baseline safe wins'
    case 'high':
      return 'broader stale payload pruning active'
    case 'critical':
      return 'compaction preferred'
  }
}
