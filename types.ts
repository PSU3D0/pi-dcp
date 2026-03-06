import type { AgentMessage } from '@mariozechner/pi-agent-core'

export interface DCPConfig {
  enabled: boolean
  mode: 'safe' | 'advanced'
  debug: boolean
  turnProtection: {
    enabled: boolean
    turns: number
  }
  stepProtection: {
    enabled: boolean
    steps: number
  }
  thresholds: {
    nudge: number
    autoPrune: number
    forceCompact: number
  }
  protectedTools: string[]
  protectedFilePatterns: string[]
  strategies: {
    deduplicate: { enabled: boolean }
    purgeErrors: { enabled: boolean; minTurnAge: number }
    outputBodyReplace: { enabled: boolean; minChars: number }
    supersedeWrites: { enabled: boolean }
  }
  advanced: {
    distillTool: { enabled: boolean }
    compressTool: { enabled: boolean }
    llmAutonomy: boolean
  }
}

export type DCPStrategyName =
  | 'deduplicate'
  | 'purgeErrors'
  | 'outputBodyReplace'
  | 'supersedeWrites'

export type DCPPressureBand = 'unknown' | 'low' | 'medium' | 'high' | 'critical'
export type DCPEffectivePressureBand = Exclude<DCPPressureBand, 'unknown'>

export interface DCPPressureState {
  band: DCPPressureBand
  effectiveBand: DCPEffectivePressureBand
  sampledAt: 'pre-prune'
  tokens: number | null
  contextWindow: number | null
  usageRatio: number | null
  thresholds: DCPConfig['thresholds']
  meaning: string
  compactionPreferred: boolean
}

export interface DCPAgeBucketSummary {
  totalMessages: number
  protectedMessages: number
  staleMessages: number
  buckets: Record<string, number>
}

export interface DCPProtectionSummary {
  turnProtection: {
    enabled: boolean
    turns: number
  }
  stepProtection: {
    enabled: boolean
    steps: number
    active: boolean
    note: string
  }
  protectedToolsCount: number
  protectedFilePatterns: {
    count: number
    enforced: boolean
  }
  frontierPins: {
    count: number
    reasons: Record<string, number>
  }
}

export interface DCPConfigActivationSummary {
  active: string[]
  ignored: string[]
  experimental: string[]
}

export interface DCPStrategyDecisionSummary {
  enabled: boolean
  pruned: number
  skippedProtected: number
  skippedRecent: number
  skippedOther: number
  note?: string
}

export interface DCPObservabilityState {
  mode: DCPConfig['mode']
  pressure: DCPPressureState
  protection: DCPProtectionSummary
  ageBuckets: DCPAgeBucketSummary
  configActivation: DCPConfigActivationSummary
  strategyDecisions: Record<DCPStrategyName, DCPStrategyDecisionSummary>
  pinnedItems: DCPPinnedItemDetail[]
}

export interface DCPPinnedItemDetail {
  subjectKey: string
  toolName: string
  turnAge: number
  stepAge: number
  argsSummary: string
  reasons: string[]
}

export interface PrunedItemDetail {
  strategy: string
  toolName: string
  turnAge: number
  tokensSaved: number
  argsSummary: string
}

export interface DCPSessionState {
  stats: {
    tokensSavedEstimate: number
    prunedItemsCount: Record<string, number>
    protectedSkipCount: number
  }
  details: PrunedItemDetail[]
  observability: DCPObservabilityState
  internal: {
    protectedSkipKeys: Set<string>
  }
}

export interface DCPMessageProtection {
  protected: boolean
  viaTurnWindow: boolean
  viaStepWindow: boolean
  viaToolProtection: boolean
  viaFileProtection: boolean
  viaFrontierPin: boolean
  pinReasons: string[]
  turnAge: number
  stepAge: number
  currentTurnExecution: boolean
}

export interface DCPProtectionPolicy {
  turnAges: number[]
  stepAges: number[]
  steps: StepSlice[]
  get(
    index: number,
    options?: { toolName?: string; toolCallId?: string; toolArgs?: any }
  ): DCPMessageProtection
  listPinnedItems(): DCPPinnedItemDetail[]
  frontierPinReasons: Record<string, number>
}

export type StepKind = 'assistant' | 'tool' | 'orphanToolResult'

export interface StepSlice {
  index: number
  age: number
  kind: StepKind
  start: number
  // Inclusive message index for the end of this step slice.
  end: number
  toolCallIds: string[]
  toolNames: string[]
}
