import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ExtensionContext } from '@mariozechner/pi-coding-agent'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import { handleContextTransform } from './hooks/context-transform'
import { loadConfig, mergeConfig, parseConfigText } from './config'
import { createSessionState } from './state'
import type {
  DCPConfig,
  DCPEffectivePressureBand,
  DCPSessionState,
  DCPPinnedItemDetail,
  PrunedItemDetail,
} from './types'

export type ReplayOutputFormat = 'markdown' | 'json'
export type ReplaySourceKind = 'session' | 'embedded-subagent'

export interface SessionJsonlEntry {
  type?: string
  id?: string
  timestamp?: string
  message?: any
  [key: string]: unknown
}

export interface ReplayPressureInput {
  tokens?: number
  contextWindow?: number
  band?: 'unknown' | DCPEffectivePressureBand
}

export interface ReplayRequest {
  sessionPath: string
  cwd?: string
  configPath?: string
  headLine?: number
  headMessageId?: string
  subagentLine?: number
  subagentResultIndex?: number
  pressure?: ReplayPressureInput
}

export interface ReplaySummary {
  source: {
    kind: ReplaySourceKind
    sessionPath: string
    cwd: string
    headLine?: number
    headMessageId?: string
    selectedEntryLine?: number
    subagentLine?: number
    subagentResultIndex?: number
  }
  config: {
    configPath?: string
    mode: string
    turnProtectionTurns: number
    stepProtectionSteps: number
    thresholds: DCPConfig['thresholds']
  }
  pressure: {
    tokens: number | null
    contextWindow: number | null
    requestedBand?: 'unknown' | DCPEffectivePressureBand
    effectiveBand: string
    meaning: string
  }
  counts: {
    originalMessages: number
    transformedMessages: number
    originalEstimatedTokens: number
    transformedEstimatedTokens: number
    tokensSavedEstimate: number
    protectedSkips: number
  }
  statusLabel?: string
  prunedItems: PrunedItemDetail[]
  pinnedItems: DCPPinnedItemDetail[]
  transformedMessages: AgentMessage[]
}

export function replaySession(request: ReplayRequest): ReplaySummary {
  const sessionPath = resolve(request.sessionPath)
  const cwd = resolve(request.cwd ?? process.cwd())
  const config = loadReplayConfig(cwd, request.configPath)
  const entries = parseSessionJsonl(readFileSync(sessionPath, 'utf8'))
  const source = selectReplaySource(entries, request)
  const originalMessages = structuredClone(source.messages)
  const transformedMessages = structuredClone(source.messages)
  const originalEstimatedTokens = estimateMessagesTokens(originalMessages)
  const replayCtx = createReplayContext(config, cwd, request.pressure)
  const state = createSessionState(config)

  handleContextTransform(
    transformedMessages,
    config,
    state,
    replayCtx as ExtensionContext
  )

  const transformedEstimatedTokens = estimateMessagesTokens(transformedMessages)

  return {
    source: {
      kind: source.kind,
      sessionPath,
      cwd,
      headLine: request.headLine,
      headMessageId: request.headMessageId,
      selectedEntryLine: source.selectedEntryLine,
      subagentLine: request.subagentLine,
      subagentResultIndex: request.subagentResultIndex ?? 0,
    },
    config: {
      configPath: request.configPath,
      mode: config.mode,
      turnProtectionTurns: config.turnProtection.turns,
      stepProtectionSteps: config.stepProtection.steps,
      thresholds: config.thresholds,
    },
    pressure: {
      tokens: state.observability.pressure.tokens,
      contextWindow: state.observability.pressure.contextWindow,
      requestedBand: request.pressure?.band,
      effectiveBand: state.observability.pressure.effectiveBand,
      meaning: state.observability.pressure.meaning,
    },
    counts: {
      originalMessages: originalMessages.length,
      transformedMessages: transformedMessages.length,
      originalEstimatedTokens,
      transformedEstimatedTokens,
      tokensSavedEstimate: state.stats.tokensSavedEstimate,
      protectedSkips: state.stats.protectedSkipCount,
    },
    statusLabel: replayCtx.statusValue,
    prunedItems: state.details.map((item) => ({ ...item })),
    pinnedItems: state.observability.pinnedItems.map((item) => ({
      ...item,
      reasons: [...item.reasons],
    })),
    transformedMessages,
  }
}

export function parseSessionJsonl(text: string): SessionJsonlEntry[] {
  const entries: SessionJsonlEntry[] = []
  const lines = text.split(/\r?\n/)

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    entries.push(JSON.parse(trimmed) as SessionJsonlEntry)
  }

  return entries
}

export function extractSessionMessages(
  entries: SessionJsonlEntry[],
  options: { headLine?: number; headMessageId?: string } = {}
): { messages: AgentMessage[]; selectedEntryLine?: number } {
  const maxIndex = resolveHeadLine(entries, options)
  const messages: AgentMessage[] = []
  let selectedEntryLine: number | undefined

  for (let index = 0; index < entries.length; index++) {
    if (maxIndex !== undefined && index > maxIndex) break
    const entry = entries[index]
    const message = entry.message

    if (!message || typeof message !== 'object') continue
    if (!isAgentMessage(message)) continue

    messages.push(structuredClone(message))
    selectedEntryLine = index + 1
  }

  return { messages, selectedEntryLine }
}

export function extractEmbeddedSubagentMessages(
  entries: SessionJsonlEntry[],
  lineNumber: number,
  resultIndex = 0
): { messages: AgentMessage[]; selectedEntryLine: number } {
  const entry = entries[lineNumber - 1]
  if (!entry) {
    throw new Error(`No session entry at line ${lineNumber}`)
  }

  const results = entry.message?.details?.results
  if (!Array.isArray(results)) {
    throw new Error(
      `Entry at line ${lineNumber} does not contain subagent results`
    )
  }

  const result = results[resultIndex]
  if (!result) {
    throw new Error(
      `Entry at line ${lineNumber} does not have subagent result index ${resultIndex}`
    )
  }

  if (!Array.isArray(result.messages)) {
    throw new Error(
      `Subagent result ${resultIndex} at line ${lineNumber} does not contain messages`
    )
  }

  const messages = result.messages
    .filter(isAgentMessage)
    .map((message: AgentMessage) => structuredClone(message))

  return {
    messages,
    selectedEntryLine: lineNumber,
  }
}

export function formatReplaySummary(
  summary: ReplaySummary,
  format: ReplayOutputFormat = 'markdown'
): string {
  if (format === 'json') {
    return JSON.stringify(summary, null, 2)
  }

  const lines: string[] = []
  lines.push('# DCP Session Replay')
  lines.push('')
  lines.push('## Source')
  lines.push(`- Kind: ${summary.source.kind}`)
  lines.push(`- Session: ${summary.source.sessionPath}`)
  lines.push(`- CWD: ${summary.source.cwd}`)
  if (summary.source.subagentLine) {
    lines.push(
      `- Embedded subagent: line ${summary.source.subagentLine}, result ${summary.source.subagentResultIndex ?? 0}`
    )
  } else if (summary.source.selectedEntryLine) {
    lines.push(`- Head line: ${summary.source.selectedEntryLine}`)
  }
  if (summary.source.headMessageId) {
    lines.push(`- Head message id: ${summary.source.headMessageId}`)
  }
  lines.push('')
  lines.push('## Replay Summary')
  lines.push(`- Messages: ${summary.counts.originalMessages}`)
  lines.push(
    `- Estimated tokens: ~${summary.counts.originalEstimatedTokens} -> ~${summary.counts.transformedEstimatedTokens}`
  )
  lines.push(`- Tokens saved estimate: ~${summary.counts.tokensSavedEstimate}`)
  lines.push(`- Protected skips: ${summary.counts.protectedSkips}`)
  lines.push(
    `- Pressure: ${summary.pressure.effectiveBand}${summary.pressure.requestedBand ? ` (requested ${summary.pressure.requestedBand})` : ''}`
  )
  lines.push(`- Pressure meaning: ${summary.pressure.meaning}`)
  if (summary.statusLabel) {
    lines.push(`- Status label: ${summary.statusLabel}`)
  }
  lines.push('')
  lines.push('## Config')
  lines.push(`- Mode: ${summary.config.mode}`)
  lines.push(`- Turn protection: ${summary.config.turnProtectionTurns}`)
  lines.push(`- Step protection: ${summary.config.stepProtectionSteps}`)
  lines.push(
    `- Thresholds: nudge=${summary.config.thresholds.nudge}, autoPrune=${summary.config.thresholds.autoPrune}, forceCompact=${summary.config.thresholds.forceCompact}`
  )

  lines.push('')
  lines.push('## Pruned Items')
  if (summary.prunedItems.length === 0) {
    lines.push('- None')
  } else {
    for (const item of summary.prunedItems.slice(0, 20)) {
      lines.push(
        `- ${item.strategy} • ${item.toolName} • turn ${item.turnAge} • ~${item.tokensSaved} tokens • ${item.argsSummary}`
      )
    }
    if (summary.prunedItems.length > 20) {
      lines.push(`- ... ${summary.prunedItems.length - 20} more`)
    }
  }

  lines.push('')
  lines.push('## Pinned Items')
  if (summary.pinnedItems.length === 0) {
    lines.push('- None')
  } else {
    for (const item of summary.pinnedItems.slice(0, 20)) {
      lines.push(
        `- ${item.toolName} [turn ${item.turnAge}, step ${item.stepAge}] • ${item.argsSummary} • reasons: ${item.reasons.join(', ')}`
      )
    }
    if (summary.pinnedItems.length > 20) {
      lines.push(`- ... ${summary.pinnedItems.length - 20} more`)
    }
  }

  return lines.join('\n')
}

export function writeTransformedMessages(
  summary: ReplaySummary,
  outputPath: string
): void {
  writeFileSync(
    outputPath,
    JSON.stringify(summary.transformedMessages, null, 2)
  )
}

function loadReplayConfig(cwd: string, explicitConfigPath?: string): DCPConfig {
  if (!explicitConfigPath) {
    return loadConfig(cwd)
  }

  const override = parseConfigText(
    readFileSync(resolve(explicitConfigPath), 'utf8')
  )
  return mergeConfig(loadConfig(cwd), override)
}

function selectReplaySource(
  entries: SessionJsonlEntry[],
  request: ReplayRequest
): {
  kind: ReplaySourceKind
  messages: AgentMessage[]
  selectedEntryLine?: number
} {
  if (request.subagentLine !== undefined) {
    const extracted = extractEmbeddedSubagentMessages(
      entries,
      request.subagentLine,
      request.subagentResultIndex ?? 0
    )
    return {
      kind: 'embedded-subagent',
      messages: extracted.messages,
      selectedEntryLine: extracted.selectedEntryLine,
    }
  }

  const extracted = extractSessionMessages(entries, {
    headLine: request.headLine,
    headMessageId: request.headMessageId,
  })

  return {
    kind: 'session',
    messages: extracted.messages,
    selectedEntryLine: extracted.selectedEntryLine,
  }
}

function resolveHeadLine(
  entries: SessionJsonlEntry[],
  options: { headLine?: number; headMessageId?: string }
): number | undefined {
  if (options.headLine !== undefined) {
    return Math.max(0, options.headLine - 1)
  }

  if (options.headMessageId) {
    const index = entries.findIndex(
      (entry) => entry.id === options.headMessageId
    )
    if (index === -1) {
      throw new Error(`Could not find message id ${options.headMessageId}`)
    }
    return index
  }

  return undefined
}

function createReplayContext(
  config: DCPConfig,
  cwd: string,
  pressure?: ReplayPressureInput
): ExtensionContext & { statusValue?: string } {
  const usage = buildReplayUsage(config, pressure)
  const replayCtx = {
    cwd,
    getContextUsage: usage ? () => usage : undefined,
    ui: {
      setStatus: (key: string, value: string | undefined) => {
        if (key === 'dcp') {
          replayCtx.statusValue = value
        }
      },
      notify: () => {},
      editor: () => {},
    },
    statusValue: undefined as string | undefined,
  }

  return replayCtx as unknown as ExtensionContext & { statusValue?: string }
}

function buildReplayUsage(
  config: DCPConfig,
  pressure?: ReplayPressureInput
): { tokens: number; contextWindow: number } | undefined {
  if (pressure?.tokens !== undefined && pressure.contextWindow !== undefined) {
    return {
      tokens: pressure.tokens,
      contextWindow: pressure.contextWindow,
    }
  }

  if (!pressure?.band || pressure.band === 'unknown') {
    return undefined
  }

  const contextWindow = 1000
  const ratioByBand: Record<DCPEffectivePressureBand, number> = {
    low: Math.max(config.thresholds.nudge - 0.05, 0.1),
    medium: Math.max(config.thresholds.nudge + 0.02, config.thresholds.nudge),
    high: Math.max(
      config.thresholds.autoPrune + 0.02,
      config.thresholds.autoPrune
    ),
    critical: Math.max(
      config.thresholds.forceCompact + 0.02,
      config.thresholds.forceCompact
    ),
  }

  return {
    tokens: Math.floor(contextWindow * ratioByBand[pressure.band]),
    contextWindow,
  }
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
  return messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    0
  )
}

function estimateMessageTokens(message: AgentMessage): number {
  if (message.role === 'user') {
    return estimateUnknownContentTokens(message.content)
  }

  if (message.role === 'assistant') {
    return estimateUnknownContentTokens(message.content)
  }

  if (message.role === 'toolResult') {
    return estimateUnknownContentTokens(message.content)
  }

  return 0
}

function estimateUnknownContentTokens(content: unknown): number {
  const text = collectVisibleText(content)
  return Math.floor(text.length / 4)
}

function collectVisibleText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value))
    return value.map((item) => collectVisibleText(item)).join('\n')
  if (!value || typeof value !== 'object') return ''

  const candidate = value as Record<string, unknown>
  let text = ''

  if (typeof candidate.text === 'string') {
    text += candidate.text
  }

  if (candidate.type === 'toolCall') {
    text += JSON.stringify({
      name: candidate.name,
      arguments: candidate.arguments,
    })
  }

  for (const nested of Object.values(candidate)) {
    if (nested !== candidate.text && nested !== candidate.arguments) {
      text += collectVisibleText(nested)
    }
  }

  return text
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== 'object') return false
  const role = (value as { role?: unknown }).role
  return role === 'user' || role === 'assistant' || role === 'toolResult'
}
