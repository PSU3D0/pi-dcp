import type { ExtensionContext } from '@mariozechner/pi-coding-agent'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { DCPConfig, DCPSessionState } from '../types'
import { buildAgeModel, buildToolCallIndex } from '../utils'
import { createProtectionPolicy } from '../protection'
import { applyDeduplicate } from '../strategies/deduplicate'
import { applyPurgeErrors } from '../strategies/purge-errors'
import { applySupersedeWrites } from '../strategies/supersede-writes'
import { applyOutputBodyReplace } from '../strategies/output-replace'
import { resetSessionState } from '../state'
import { refreshObservabilityState } from '../observability'
import {
  describePressureFooterLabel,
  isStrategyEnabledForPressure,
} from '../pressure-policy'

export function handleContextTransform(
  messages: AgentMessage[],
  config: DCPConfig,
  state: DCPSessionState,
  ctx: ExtensionContext
) {
  if (!config.enabled) return { messages }

  resetSessionState(state, config)

  const ageModel = buildAgeModel(messages)
  const toolArgsIndex = buildToolCallIndex(messages)
  const protectionPolicy = createProtectionPolicy(
    messages,
    config,
    ageModel,
    toolArgsIndex,
    ctx.cwd ?? process.cwd()
  )
  const usage = ctx.getContextUsage?.()

  refreshObservabilityState(state, config, protectionPolicy, usage)

  if (
    config.strategies.deduplicate.enabled &&
    isStrategyEnabledForPressure('deduplicate', state.observability.pressure)
  ) {
    applyDeduplicate(messages, config, state, toolArgsIndex, protectionPolicy)
  }

  if (
    config.strategies.purgeErrors.enabled &&
    isStrategyEnabledForPressure('purgeErrors', state.observability.pressure)
  ) {
    applyPurgeErrors(messages, config, state, protectionPolicy)
  }

  if (
    config.strategies.supersedeWrites.enabled &&
    isStrategyEnabledForPressure(
      'supersedeWrites',
      state.observability.pressure
    )
  ) {
    applySupersedeWrites(
      messages,
      config,
      state,
      toolArgsIndex,
      protectionPolicy
    )
  }

  if (
    config.strategies.outputBodyReplace.enabled &&
    isStrategyEnabledForPressure(
      'outputBodyReplace',
      state.observability.pressure
    )
  ) {
    applyOutputBodyReplace(
      messages,
      config,
      state,
      toolArgsIndex,
      protectionPolicy
    )
  }

  const pressureLabel = ` · ${state.observability.pressure.effectiveBand} ${state.observability.pressure.sampledAt} pressure (${describePressureFooterLabel(
    state.observability.pressure.band
  )})`

  if (state.stats.tokensSavedEstimate > 0) {
    ctx.ui.setStatus(
      'dcp',
      `✂️ DCP: ~${state.stats.tokensSavedEstimate} tokens saved${pressureLabel}`
    )
  } else if (config.debug) {
    ctx.ui.setStatus('dcp', `DCP: 0 tokens saved${pressureLabel}`)
  } else {
    // Clear status if no tokens saved and not debugging
    ctx.ui.setStatus('dcp', undefined)
  }

  return { messages }
}
