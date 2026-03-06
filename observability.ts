import type {
  DCPAgeBucketSummary,
  DCPConfig,
  DCPConfigActivationSummary,
  DCPObservabilityState,
  DCPPinnedItemDetail,
  DCPPressureState,
  DCPProtectionPolicy,
  DCPStrategyDecisionSummary,
  DCPStrategyName,
  DCPSessionState,
} from './types'
import {
  describeEffectivePressureBand,
  getEffectivePressureBand,
  getStrategyMinimumBand,
  isStrategyEnabledForPressure,
} from './pressure-policy'

const STRATEGY_NAMES: DCPStrategyName[] = [
  'deduplicate',
  'purgeErrors',
  'outputBodyReplace',
  'supersedeWrites',
]

export function createObservabilityState(
  config?: DCPConfig,
  protectionPolicy?: DCPProtectionPolicy,
  usage?: { tokens?: number | null; contextWindow?: number | null } | null
): DCPObservabilityState {
  if (!config) {
    return {
      mode: 'safe',
      pressure: {
        band: 'unknown',
        effectiveBand: 'low',
        sampledAt: 'pre-prune',
        tokens: null,
        contextWindow: null,
        usageRatio: null,
        thresholds: {
          nudge: 0,
          autoPrune: 0,
          forceCompact: 0,
        },
        meaning:
          'baseline safe wins active; ctx.getContextUsage unavailable so large-output pruning stays off',
        compactionPreferred: false,
      },
      protection: {
        turnProtection: {
          enabled: false,
          turns: 0,
        },
        stepProtection: {
          enabled: false,
          steps: 0,
          active: false,
          note: 'disabled',
        },
        protectedToolsCount: 0,
        protectedFilePatterns: {
          count: 0,
          enforced: false,
        },
        frontierPins: {
          count: 0,
          reasons: {},
        },
      },
      ageBuckets: {
        totalMessages: 0,
        protectedMessages: 0,
        staleMessages: 0,
        buckets: {},
      },
      configActivation: {
        active: [],
        ignored: [],
        experimental: [],
      },
      strategyDecisions: createStrategyDecisions(),
      pinnedItems: [],
    }
  }

  const pressure = computePressureState(config, usage)

  return {
    mode: config.mode,
    pressure,
    protection: buildProtectionSummary(config, protectionPolicy),
    ageBuckets: computeAgeBuckets(config, protectionPolicy),
    configActivation: describeConfigActivation(config),
    strategyDecisions: createStrategyDecisions(config, pressure),
    pinnedItems: protectionPolicy?.listPinnedItems() ?? [],
  }
}

export function computePressureState(
  config: DCPConfig,
  usage?: { tokens?: number | null; contextWindow?: number | null } | null
): DCPPressureState {
  const tokens = typeof usage?.tokens === 'number' ? usage.tokens : null
  const contextWindow =
    typeof usage?.contextWindow === 'number' && usage.contextWindow > 0
      ? usage.contextWindow
      : null
  const usageRatio =
    tokens !== null && contextWindow !== null ? tokens / contextWindow : null

  let band: DCPPressureState['band'] = 'unknown'
  if (usageRatio !== null) {
    if (usageRatio >= config.thresholds.forceCompact) {
      band = 'critical'
    } else if (usageRatio >= config.thresholds.autoPrune) {
      band = 'high'
    } else if (usageRatio >= config.thresholds.nudge) {
      band = 'medium'
    } else {
      band = 'low'
    }
  }

  const effectiveBand = getEffectivePressureBand(band)

  return {
    band,
    effectiveBand,
    sampledAt: 'pre-prune',
    tokens,
    contextWindow,
    usageRatio,
    thresholds: { ...config.thresholds },
    meaning: describeEffectivePressureBand(band),
    compactionPreferred: effectiveBand === 'critical',
  }
}

export function refreshObservabilityState(
  state: DCPSessionState,
  config: DCPConfig,
  protectionPolicy?: DCPProtectionPolicy,
  usage?: { tokens?: number | null; contextWindow?: number | null } | null
): void {
  state.observability = createObservabilityState(
    config,
    protectionPolicy,
    usage
  )
}

export function recordStrategyPruned(
  state: DCPSessionState,
  strategy: DCPStrategyName
): void {
  state.observability.strategyDecisions[strategy].pruned++
}

export function recordStrategySkip(
  state: DCPSessionState,
  strategy: DCPStrategyName,
  reason: 'protected' | 'recent' | 'other',
  subjectKey?: string
): void {
  const summary = state.observability.strategyDecisions[strategy]

  if (reason === 'protected') {
    summary.skippedProtected++

    if (!subjectKey || !state.internal.protectedSkipKeys.has(subjectKey)) {
      if (subjectKey) {
        state.internal.protectedSkipKeys.add(subjectKey)
      }
      state.stats.protectedSkipCount++
    }
    return
  }

  if (reason === 'recent') {
    summary.skippedRecent++
    return
  }

  summary.skippedOther++
}

export function buildStatusMessage(
  config: DCPConfig,
  state: DCPSessionState
): string {
  const pressure = state.observability.pressure
  const protection = state.observability.protection
  const activation = state.observability.configActivation
  const lines: string[] = []

  lines.push('**DCP Status**: Enabled')
  lines.push(
    `- Mode: ${config.mode} (reported only, no extra policy branching yet)`
  )
  lines.push(`- Pressure: ${formatPressureLine(pressure)}`)
  lines.push(
    `- Effective band: ${formatEffectiveBandLine(pressure)}; thresholds: ${formatThresholds(
      config.thresholds
    )}`
  )
  lines.push(
    `- Protection windows: turns=${protection.turnProtection.enabled ? protection.turnProtection.turns : 'disabled'}, steps=${protection.stepProtection.active ? protection.stepProtection.steps : 'disabled'} (${protection.stepProtection.note}), protected tools=${protection.protectedToolsCount}, protectedFilePatterns=${protection.protectedFilePatterns.count} enforced, frontierPins=${protection.frontierPins.count}${formatFrontierReasonSuffix(protection.frontierPins.reasons)}`
  )
  lines.push(
    `- Config activation: active=${formatList(activation.active)}; ignored=${formatList(activation.ignored)}; experimental=${formatList(activation.experimental)}`
  )
  lines.push(`- Tokens Saved: ~${state.stats.tokensSavedEstimate}`)
  lines.push(
    `- Items Pruned: ${JSON.stringify(state.stats.prunedItemsCount, null, 2)}`
  )
  lines.push(`- Protected Skips: ${state.stats.protectedSkipCount}`)

  return lines.join('\n')
}

export function buildDetailsMarkdown(
  config: DCPConfig,
  state: DCPSessionState
): string {
  const pressure = state.observability.pressure
  const protection = state.observability.protection
  const activation = state.observability.configActivation
  const lines: string[] = []

  lines.push('# DCP Details')
  lines.push('')
  lines.push('## Runtime')
  lines.push(
    `- Mode: \`${config.mode}\` (reported, no extra policy branching yet)`
  )
  lines.push(`- Pressure: ${formatPressureLine(pressure)}`)
  lines.push(`- Effective band: ${formatEffectiveBandLine(pressure)}`)
  lines.push(`- Thresholds: ${formatThresholds(config.thresholds)}`)
  lines.push(
    `- Protection windows: turns=${protection.turnProtection.enabled ? protection.turnProtection.turns : 'disabled'}, steps=${protection.stepProtection.active ? protection.stepProtection.steps : 'disabled'} (${protection.stepProtection.note})`
  )
  lines.push(`- Protected tools: ${protection.protectedToolsCount}`)
  lines.push(
    `- protectedFilePatterns: ${protection.protectedFilePatterns.count} configured, enforced`
  )
  lines.push(
    `- Frontier pins: ${protection.frontierPins.count}${formatFrontierReasonSuffix(protection.frontierPins.reasons)}`
  )
  lines.push('')
  lines.push('## Config Activation')
  lines.push(`- Active: ${formatList(activation.active)}`)
  lines.push(`- Ignored: ${formatList(activation.ignored)}`)
  lines.push(`- Experimental: ${formatList(activation.experimental)}`)
  lines.push('')
  lines.push('## Debug Summary')
  lines.push(
    `- Age buckets: ${formatAgeBuckets(state.observability.ageBuckets)}`
  )
  lines.push(`- Protected skips: ${state.stats.protectedSkipCount}`)
  lines.push('- Strategy decisions:')

  for (const name of STRATEGY_NAMES) {
    const summary = state.observability.strategyDecisions[name]
    let line = `- \`${name}\`: ${summary.enabled ? 'enabled' : 'disabled'}; pruned ${summary.pruned}; skipped protected ${summary.skippedProtected}; skipped recent ${summary.skippedRecent}; skipped other ${summary.skippedOther}`
    if (summary.note) {
      line += `; ${summary.note}`
    }
    lines.push(line)
  }

  lines.push('')
  lines.push('## Pinned Items')

  if (state.observability.pinnedItems.length === 0) {
    lines.push('No file/frontier pins in the latest transform.')
  } else {
    for (const item of state.observability.pinnedItems) {
      lines.push(
        `- **${item.toolName}** [${formatPinnedAge(item)}]: \`${item.argsSummary}\` — ${item.reasons.join('; ')}`
      )
    }
  }

  lines.push('')
  lines.push('## Pruned Items')

  if (state.details.length === 0) {
    lines.push('No items pruned in the latest transform.')
    return lines.join('\n')
  }

  const grouped = state.details.reduce(
    (acc, item) => {
      if (!acc[item.strategy]) acc[item.strategy] = []
      acc[item.strategy].push(item)
      return acc
    },
    {} as Record<string, typeof state.details>
  )

  lines.push(`~${state.stats.tokensSavedEstimate} tokens saved`)
  lines.push('')

  for (const [strategy, items] of Object.entries(grouped)) {
    lines.push(`### ${strategy} (${items.length})`)
    for (const item of items) {
      const turnStr =
        item.turnAge >= 0 ? `Turn ${item.turnAge}` : 'Assistant Action'
      lines.push(
        `- **${item.toolName}** [${turnStr}] (~${item.tokensSaved} tokens): \`${item.argsSummary}\``
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}

function createStrategyDecisions(
  config?: DCPConfig,
  pressure?: DCPPressureState
): Record<DCPStrategyName, DCPStrategyDecisionSummary> {
  return {
    deduplicate: createStrategyDecision(
      'deduplicate',
      config,
      pressure,
      'exact tool+args duplicates'
    ),
    purgeErrors: createStrategyDecision(
      'purgeErrors',
      config,
      pressure,
      config
        ? `minTurnAge=${config.strategies.purgeErrors.minTurnAge}`
        : undefined
    ),
    outputBodyReplace: createStrategyDecision(
      'outputBodyReplace',
      config,
      pressure,
      config
        ? `minChars=${config.strategies.outputBodyReplace.minChars}`
        : undefined
    ),
    supersedeWrites: createStrategyDecision(
      'supersedeWrites',
      config,
      pressure,
      'later read can supersede older write args'
    ),
  }
}

function createStrategyDecision(
  strategy: DCPStrategyName,
  config: DCPConfig | undefined,
  pressure: DCPPressureState | undefined,
  baseNote?: string
): DCPStrategyDecisionSummary {
  const enabledInConfig = config
    ? isStrategyEnabledInConfig(config, strategy)
    : false
  const enabledByPressure = pressure
    ? isStrategyEnabledForPressure(strategy, pressure)
    : true
  const enabled = enabledInConfig && enabledByPressure
  const noteParts: string[] = []

  if (baseNote) {
    noteParts.push(baseNote)
  }

  if (config && pressure) {
    const minimumBand = getStrategyMinimumBand(strategy)
    if (!enabledInConfig) {
      noteParts.push('disabled in config')
    } else if (enabledByPressure) {
      noteParts.push(`active at ${minimumBand}+ pressure`)
    } else {
      noteParts.push(
        `gated until ${minimumBand} pressure (current ${pressure.effectiveBand})`
      )
    }
  }

  return {
    enabled,
    pruned: 0,
    skippedProtected: 0,
    skippedRecent: 0,
    skippedOther: 0,
    note: noteParts.length > 0 ? noteParts.join('; ') : undefined,
  }
}

function isStrategyEnabledInConfig(
  config: DCPConfig,
  strategy: DCPStrategyName
): boolean {
  switch (strategy) {
    case 'deduplicate':
      return config.strategies.deduplicate.enabled
    case 'purgeErrors':
      return config.strategies.purgeErrors.enabled
    case 'outputBodyReplace':
      return config.strategies.outputBodyReplace.enabled
    case 'supersedeWrites':
      return config.strategies.supersedeWrites.enabled
  }
}

function describeConfigActivation(
  config: DCPConfig
): DCPConfigActivationSummary {
  const active = ['turnProtection', 'protectedTools', 'protectedFilePatterns']
  const ignored: string[] = []

  if (config.stepProtection.enabled && config.stepProtection.steps > 0) {
    active.push('stepProtection')
  } else {
    ignored.push('stepProtection (disabled)')
  }

  active.push('thresholds (pressure gates)')

  return {
    active,
    ignored,
    experimental: [
      `advanced.distillTool (${config.advanced.distillTool.enabled ? 'enabled but dormant' : 'disabled'})`,
      `advanced.compressTool (${config.advanced.compressTool.enabled ? 'enabled but dormant' : 'disabled'})`,
      `advanced.llmAutonomy (${config.advanced.llmAutonomy ? 'enabled but dormant' : 'disabled'})`,
    ],
  }
}

function buildProtectionSummary(
  config: DCPConfig,
  protectionPolicy?: DCPProtectionPolicy
): DCPObservabilityState['protection'] {
  const stepProtectionActive =
    config.stepProtection.enabled && config.stepProtection.steps > 0
  const pinnedItems = protectionPolicy?.listPinnedItems() ?? []
  const frontierPinnedItems = pinnedItems.filter((item) =>
    item.reasons.some(isFrontierReason)
  )

  return {
    turnProtection: {
      enabled: config.turnProtection.enabled,
      turns: config.turnProtection.turns,
    },
    stepProtection: {
      enabled: config.stepProtection.enabled,
      steps: config.stepProtection.steps,
      active: stepProtectionActive,
      note: stepProtectionActive
        ? 'short current turns stay on turn protection; once a same-turn run grows past the turn window, the newest steps stay protected and recent prior turns still stay protected'
        : 'disabled',
    },
    protectedToolsCount: config.protectedTools.length,
    protectedFilePatterns: {
      count: config.protectedFilePatterns.length,
      enforced: true,
    },
    frontierPins: {
      count: frontierPinnedItems.length,
      reasons: summarizeFrontierReasons(frontierPinnedItems),
    },
  }
}

function computeAgeBuckets(
  config: DCPConfig,
  protectionPolicy?: DCPProtectionPolicy
): DCPAgeBucketSummary {
  const turnAges = protectionPolicy?.turnAges ?? []
  const buckets: Record<string, number> = {}
  let protectedMessages = 0
  let staleMessages = 0

  for (let index = 0; index < turnAges.length; index++) {
    const age = turnAges[index]
    const bucket = getAgeBucketLabel(age, config)
    buckets[bucket] = (buckets[bucket] ?? 0) + 1

    if (protectionPolicy?.get(index).protected) {
      protectedMessages++
    } else {
      staleMessages++
    }
  }

  return {
    totalMessages: turnAges.length,
    protectedMessages,
    staleMessages,
    buckets,
  }
}

function getAgeBucketLabel(age: number, config: DCPConfig): string {
  if (config.turnProtection.enabled && age >= config.turnProtection.turns) {
    return `T${config.turnProtection.turns}+`
  }
  return `T${age}`
}

function formatPressureLine(pressure: DCPPressureState): string {
  const snapshotLabel = `${pressure.sampledAt} snapshot`

  if (
    pressure.tokens === null ||
    pressure.contextWindow === null ||
    pressure.usageRatio === null
  ) {
    return `${pressure.band} (${snapshotLabel}; ctx.getContextUsage unavailable)`
  }

  return `${pressure.band} (${snapshotLabel}; ~${pressure.tokens.toLocaleString()} / ${pressure.contextWindow.toLocaleString()} tokens, ${formatUsagePercent(pressure.usageRatio)} used)`
}

function formatEffectiveBandLine(pressure: DCPPressureState): string {
  return `${pressure.effectiveBand} (${pressure.meaning})`
}

function formatThresholds(thresholds: DCPConfig['thresholds']): string {
  return `nudge ${formatThresholdPercent(thresholds.nudge)}, auto-prune ${formatThresholdPercent(thresholds.autoPrune)}, force-compact ${formatThresholdPercent(thresholds.forceCompact)}`
}

function formatThresholdPercent(value: number): string {
  const percent = value * 100
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`
}

function formatUsagePercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function formatAgeBuckets(summary: DCPAgeBucketSummary): string {
  const entries = Object.entries(summary.buckets)
    .sort(([left], [right]) =>
      left.localeCompare(right, undefined, { numeric: true })
    )
    .map(([bucket, count]) => `\`${bucket}=${count}\``)

  if (entries.length === 0) {
    return '(none)'
  }

  entries.push(`protected=${summary.protectedMessages}`)
  entries.push(`stale=${summary.staleMessages}`)

  return entries.join(', ')
}

function formatList(items: string[]): string {
  return items.length > 0 ? items.join(', ') : '(none)'
}

function formatFrontierReasonSuffix(reasons: Record<string, number>): string {
  const entries = Object.entries(reasons)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}=${count}`)

  return entries.length > 0 ? ` (${entries.join(', ')})` : ''
}

function formatPinnedAge(item: DCPPinnedItemDetail): string {
  if (item.stepAge >= 0) {
    return `Turn ${item.turnAge}, Step ${item.stepAge}`
  }

  if (item.turnAge >= 0) {
    return `Turn ${item.turnAge}`
  }

  return 'Assistant Action'
}

function summarizeFrontierReasons(
  items: DCPPinnedItemDetail[]
): Record<string, number> {
  const summary: Record<string, number> = {}

  for (const item of items) {
    for (const reason of item.reasons) {
      if (!isFrontierReason(reason)) {
        continue
      }
      summary[reason] = (summary[reason] ?? 0) + 1
    }
  }

  return summary
}

function isFrontierReason(reason: string): boolean {
  return (
    !reason.startsWith('protected file pattern') &&
    !reason.startsWith('protected tool') &&
    reason !== 'path normalization ambiguous; kept for safety'
  )
}
