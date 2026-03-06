import type { DCPConfig, DCPSessionState } from './types'
import { createObservabilityState } from './observability'

export function createSessionState(config?: DCPConfig): DCPSessionState {
  return {
    stats: {
      tokensSavedEstimate: 0,
      prunedItemsCount: {
        deduplicate: 0,
        purgeErrors: 0,
        outputBodyReplace: 0,
        supersedeWrites: 0,
      },
      protectedSkipCount: 0,
    },
    details: [],
    observability: createObservabilityState(config),
    internal: {
      protectedSkipKeys: new Set(),
    },
  }
}

export function resetSessionState(
  state: DCPSessionState,
  config?: DCPConfig
): void {
  state.stats.tokensSavedEstimate = 0
  state.stats.prunedItemsCount.deduplicate = 0
  state.stats.prunedItemsCount.purgeErrors = 0
  state.stats.prunedItemsCount.outputBodyReplace = 0
  state.stats.prunedItemsCount.supersedeWrites = 0
  state.stats.protectedSkipCount = 0
  state.details = []
  state.observability = createObservabilityState(config)
  state.internal.protectedSkipKeys.clear()
}
