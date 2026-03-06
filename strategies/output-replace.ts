import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { DCPConfig, DCPSessionState, DCPProtectionPolicy } from '../types'
import { estimateTokens } from '../utils'
import { recordStrategyPruned, recordStrategySkip } from '../observability'

export function applyOutputBodyReplace(
  messages: AgentMessage[],
  config: DCPConfig,
  state: DCPSessionState,
  toolArgsIndex: Map<string, any>,
  protectionPolicy: DCPProtectionPolicy
): void {
  if (!config.strategies.outputBodyReplace.enabled) return

  const minChars = config.strategies.outputBodyReplace.minChars

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]

    if (msg.role === 'toolResult' && !msg.isError) {
      const protection = protectionPolicy.get(i)
      const turnAge = protection.turnAge

      if (
        protection.viaToolProtection ||
        protection.viaFileProtection ||
        protection.viaFrontierPin
      ) {
        recordStrategySkip(
          state,
          'outputBodyReplace',
          'protected',
          `toolResult:${msg.toolCallId}`
        )
        continue
      }

      if (protection.protected) {
        recordStrategySkip(state, 'outputBodyReplace', 'recent')
        continue
      }

      // Check if it's already a DCP placeholder
      if (
        msg.content.length === 1 &&
        msg.content[0].type === 'text' &&
        msg.content[0].text.startsWith('[DCP:')
      ) {
        recordStrategySkip(state, 'outputBodyReplace', 'other')
        continue
      }

      let totalChars = 0
      for (const block of msg.content) {
        if (block.type === 'text') totalChars += block.text.length
        // if image, it's also massive, we can treat images as exceeding minChars
        if (block.type === 'image') totalChars += minChars + 1
      }

      if (totalChars < minChars) {
        recordStrategySkip(state, 'outputBodyReplace', 'other')
        continue
      }

      const tokensSaved = estimateTokens(msg.content)
      state.stats.tokensSavedEstimate += tokensSaved
      state.stats.prunedItemsCount.outputBodyReplace++
      recordStrategyPruned(state, 'outputBodyReplace')

      const args = toolArgsIndex.get(msg.toolCallId)
      const argsSummary = args
        ? JSON.stringify(args).slice(0, 100)
        : 'unknown args'

      state.details.push({
        strategy: 'outputBodyReplace',
        toolName: msg.toolName,
        turnAge,
        tokensSaved,
        argsSummary,
      })

      msg.content = [
        {
          type: 'text',
          text: `[DCP: Large output from ${msg.toolName}(${argsSummary}...) pruned due to age (Turn ${turnAge}). If you need this data again, re-run the tool.]`,
        },
      ]
    }
  }
}
