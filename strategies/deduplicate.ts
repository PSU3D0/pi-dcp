import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { DCPConfig, DCPSessionState, DCPProtectionPolicy } from '../types'
import { getToolSignature, estimateTokens } from '../utils'
import { recordStrategyPruned, recordStrategySkip } from '../observability'

export function applyDeduplicate(
  messages: AgentMessage[],
  config: DCPConfig,
  state: DCPSessionState,
  toolArgsIndex: Map<string, any>,
  protectionPolicy: DCPProtectionPolicy
): void {
  if (!config.strategies.deduplicate.enabled) return

  const seenSignatures = new Set<string>()

  // Iterate backwards (from newest to oldest) to keep the LATEST exact duplicate
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]

    if (msg.role === 'toolResult') {
      const args = toolArgsIndex.get(msg.toolCallId)
      if (!args) {
        recordStrategySkip(state, 'deduplicate', 'other')
        continue
      }

      const protection = protectionPolicy.get(i)
      const turnAge = protection.turnAge
      const sig = getToolSignature(msg.toolName, args, msg.toolCallId)

      // We still register protected tools / recent tools into seenSignatures
      // so we can prune OLDER unprotected duplicates of them.
      if (
        protection.viaToolProtection ||
        protection.viaFileProtection ||
        protection.viaFrontierPin
      ) {
        recordStrategySkip(
          state,
          'deduplicate',
          'protected',
          `toolResult:${msg.toolCallId}`
        )
        seenSignatures.add(sig)
        continue
      }

      if (protection.protected) {
        recordStrategySkip(state, 'deduplicate', 'recent')
        seenSignatures.add(sig)
        continue
      }

      if (seenSignatures.has(sig)) {
        // This is an older exact duplicate. Prune it.
        const tokensSaved = estimateTokens(msg.content)
        state.stats.tokensSavedEstimate += tokensSaved
        state.stats.prunedItemsCount.deduplicate++
        recordStrategyPruned(state, 'deduplicate')

        state.details.push({
          strategy: 'deduplicate',
          toolName: msg.toolName,
          turnAge,
          tokensSaved,
          argsSummary: JSON.stringify(args).slice(0, 100),
        })

        msg.content = [
          {
            type: 'text',
            text: `[DCP: Exact duplicate of a later tool call. Pruned to save tokens.]`,
          },
        ]
      } else {
        seenSignatures.add(sig)
      }
    }
  }
}
