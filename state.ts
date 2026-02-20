import type { DCPSessionState } from "./types";

export function createSessionState(): DCPSessionState {
  return {
    stats: {
      tokensSavedEstimate: 0,
      prunedItemsCount: {
        deduplicate: 0,
        purgeErrors: 0,
        outputBodyReplace: 0,
        supersedeWrites: 0
      },
      protectedSkipCount: 0
    },
    details: []
  };
}

export function resetSessionState(state: DCPSessionState): void {
  state.stats.tokensSavedEstimate = 0;
  state.stats.prunedItemsCount.deduplicate = 0;
  state.stats.prunedItemsCount.purgeErrors = 0;
  state.stats.prunedItemsCount.outputBodyReplace = 0;
  state.stats.prunedItemsCount.supersedeWrites = 0;
  state.stats.protectedSkipCount = 0;
  state.details = [];
}
