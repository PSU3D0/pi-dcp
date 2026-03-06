import { posix as pathPosix } from 'node:path'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type {
  DCPConfig,
  DCPPinnedItemDetail,
  DCPProtectionPolicy,
} from './types'

interface NormalizedToolPath {
  raw: string
  primary: string | null
  candidates: string[]
  ambiguous: boolean
}

interface ToolCallMeta {
  messageIndex: number
  toolCallId: string
  toolName: string
  args: any
  argsSummary: string
  pathInfo: NormalizedToolPath | null
}

interface ToolResultRef {
  messageIndex: number
  toolCallId: string
  toolName: string
  argsSummary: string
  pathInfo: NormalizedToolPath | null
}

interface SubjectProtectionEntry {
  toolName: string
  argsSummary: string
  turnAge: number
  stepAge: number
  reasons: string[]
  viaToolProtection: boolean
  viaFileProtection: boolean
  viaFrontierPin: boolean
}

export interface ProtectionIndex {
  get(subjectKey: string): SubjectProtectionEntry | undefined
  pinnedItems: DCPPinnedItemDetail[]
  frontierPinReasons: Record<string, number>
}

export function buildProtectionIndex(
  messages: AgentMessage[],
  config: DCPConfig,
  protectionPolicy: Pick<DCPProtectionPolicy, 'turnAges' | 'stepAges'>,
  toolArgsIndex: Map<string, any>,
  cwd: string
): ProtectionIndex {
  const subjectEntries = new Map<string, SubjectProtectionEntry>()
  const toolCallMetaById = new Map<string, ToolCallMeta>()
  const latestModificationByPath = new Map<string, number>()
  const latestReadByModifiedPath = new Map<string, ToolResultRef>()
  const latestPlanOrProgressReadByPath = new Map<string, ToolResultRef>()
  let latestFailingVerification: ToolResultRef | null = null
  let latestSuccessfulVerification: ToolResultRef | null = null

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index] as any

    if (message?.role === 'assistant') {
      for (const block of message.content ?? []) {
        if (
          block?.type !== 'toolCall' ||
          typeof block.id !== 'string' ||
          typeof block.name !== 'string'
        ) {
          continue
        }

        const args = block.arguments ?? toolArgsIndex.get(block.id)
        const pathInfo = normalizeToolPath(getToolPathArgument(args), cwd)
        const argsSummary = summarizeToolArgs(block.name, args, pathInfo)

        toolCallMetaById.set(block.id, {
          messageIndex: index,
          toolCallId: block.id,
          toolName: block.name,
          args,
          argsSummary,
          pathInfo,
        })

        const reasons = buildStaticReasons(config, block.name, pathInfo)
        if (reasons.length > 0) {
          subjectEntries.set(`toolCall:${block.id}`, {
            toolName: block.name,
            argsSummary,
            turnAge: protectionPolicy.turnAges[index] ?? -1,
            stepAge: protectionPolicy.stepAges[index] ?? -1,
            reasons,
            viaToolProtection: config.protectedTools.includes(block.name),
            viaFileProtection: reasons.some(
              (reason) =>
                reason.startsWith('protected file pattern') ||
                reason === 'path normalization ambiguous; kept for safety'
            ),
            viaFrontierPin: false,
          })
        }

        if (
          (block.name === 'write' || block.name === 'edit') &&
          pathInfo?.primary
        ) {
          latestModificationByPath.set(pathInfo.primary, index)
        }
      }

      continue
    }

    if (message?.role !== 'toolResult') {
      continue
    }

    const meta = toolCallMetaById.get(message.toolCallId)
    const args = meta?.args ?? toolArgsIndex.get(message.toolCallId)
    const pathInfo =
      meta?.pathInfo ?? normalizeToolPath(getToolPathArgument(args), cwd)
    const argsSummary =
      meta?.argsSummary ?? summarizeToolArgs(message.toolName, args, pathInfo)
    const ref: ToolResultRef = {
      messageIndex: index,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      argsSummary,
      pathInfo,
    }

    if (
      message.toolName === 'read' &&
      pathInfo?.primary &&
      latestModificationByPath.has(pathInfo.primary) &&
      (latestModificationByPath.get(pathInfo.primary) ??
        Number.NEGATIVE_INFINITY) < index
    ) {
      latestReadByModifiedPath.set(pathInfo.primary, ref)
    }

    if (
      message.toolName === 'read' &&
      pathInfo?.primary &&
      isPlanOrProgressArtifact(pathInfo)
    ) {
      latestPlanOrProgressReadByPath.set(pathInfo.primary, ref)
    }

    if (message.toolName === 'bash' && isVerificationCommand(args?.command)) {
      const outcome = classifyVerificationOutcome(message)
      if (outcome === 'fail') {
        latestFailingVerification = ref
      } else if (outcome === 'pass') {
        latestSuccessfulVerification = ref
      }
    }
  }

  const frontierReasonsBySubject = new Map<string, Set<string>>()

  for (const ref of latestReadByModifiedPath.values()) {
    addFrontierReason(
      frontierReasonsBySubject,
      `toolResult:${ref.toolCallId}`,
      'latest read of modified file'
    )
  }

  for (const ref of latestPlanOrProgressReadByPath.values()) {
    addFrontierReason(
      frontierReasonsBySubject,
      `toolResult:${ref.toolCallId}`,
      'current plan/progress-style artifact'
    )
  }

  if (latestFailingVerification) {
    addFrontierReason(
      frontierReasonsBySubject,
      `toolResult:${latestFailingVerification.toolCallId}`,
      'latest failing verification output'
    )
  }

  if (latestSuccessfulVerification) {
    addFrontierReason(
      frontierReasonsBySubject,
      `toolResult:${latestSuccessfulVerification.toolCallId}`,
      'latest successful verification output'
    )
  }

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index] as any
    if (
      message?.role !== 'toolResult' ||
      typeof message.toolCallId !== 'string'
    ) {
      continue
    }

    const meta = toolCallMetaById.get(message.toolCallId)
    const args = meta?.args ?? toolArgsIndex.get(message.toolCallId)
    const pathInfo =
      meta?.pathInfo ?? normalizeToolPath(getToolPathArgument(args), cwd)
    const staticReasons = buildStaticReasons(config, message.toolName, pathInfo)
    const dynamicReasons = [
      ...(frontierReasonsBySubject.get(`toolResult:${message.toolCallId}`) ??
        []),
    ]
    const reasons = [...staticReasons, ...dynamicReasons]

    if (reasons.length === 0) {
      continue
    }

    subjectEntries.set(`toolResult:${message.toolCallId}`, {
      toolName: message.toolName,
      argsSummary:
        meta?.argsSummary ??
        summarizeToolArgs(message.toolName, args, pathInfo),
      turnAge: protectionPolicy.turnAges[index] ?? -1,
      stepAge: protectionPolicy.stepAges[index] ?? -1,
      reasons,
      viaToolProtection: config.protectedTools.includes(message.toolName),
      viaFileProtection: staticReasons.some(
        (reason) =>
          reason.startsWith('protected file pattern') ||
          reason === 'path normalization ambiguous; kept for safety'
      ),
      viaFrontierPin: dynamicReasons.length > 0,
    })
  }

  const pinnedItems = [...subjectEntries.entries()]
    .filter(([, entry]) => entry.viaFileProtection || entry.viaFrontierPin)
    .map(([subjectKey, entry]) => ({
      subjectKey,
      toolName: entry.toolName,
      turnAge: entry.turnAge,
      stepAge: entry.stepAge,
      argsSummary: entry.argsSummary,
      reasons: [...entry.reasons],
    }))
    .sort(comparePinnedItems)

  const frontierPinReasons = summarizeReasons(pinnedItems)

  return {
    get(subjectKey) {
      return subjectEntries.get(subjectKey)
    },
    pinnedItems,
    frontierPinReasons,
  }
}

function addFrontierReason(
  frontierReasonsBySubject: Map<string, Set<string>>,
  subjectKey: string,
  reason: string
): void {
  let reasons = frontierReasonsBySubject.get(subjectKey)
  if (!reasons) {
    reasons = new Set<string>()
    frontierReasonsBySubject.set(subjectKey, reasons)
  }
  reasons.add(reason)
}

function buildStaticReasons(
  config: DCPConfig,
  toolName: string,
  pathInfo: NormalizedToolPath | null
): string[] {
  const reasons: string[] = []

  if (config.protectedTools.includes(toolName)) {
    reasons.push(`protected tool: ${toolName}`)
  }

  if (pathInfo?.ambiguous) {
    reasons.push('path normalization ambiguous; kept for safety')
  }

  for (const pattern of config.protectedFilePatterns) {
    if (matchesProtectedFilePattern(pathInfo, pattern)) {
      reasons.push(`protected file pattern: ${pattern}`)
    }
  }

  return reasons
}

function matchesProtectedFilePattern(
  pathInfo: NormalizedToolPath | null,
  pattern: string
): boolean {
  if (!pathInfo || pattern.trim().length === 0) {
    return false
  }

  const regex = globToRegExp(pattern)
  return pathInfo.candidates.some((candidate) => regex.test(candidate))
}

function normalizeToolPath(
  rawPath: unknown,
  cwd: string
): NormalizedToolPath | null {
  if (typeof rawPath !== 'string') {
    return null
  }

  const trimmed = rawPath.trim()
  if (trimmed.length === 0) {
    return null
  }

  const raw = toPosixPath(trimmed)
  const cwdPosix = toPosixPath(cwd)
  const candidates = new Set<string>()

  const normalizedRaw = normalizePosixPath(raw)
  addPathCandidate(candidates, normalizedRaw)
  addPathCandidate(candidates, stripLeadingCurrentDir(normalizedRaw))

  if (isAbsoluteLike(normalizedRaw)) {
    addPathCandidate(candidates, normalizedRaw)
  } else {
    addPathCandidate(
      candidates,
      normalizePosixPath(pathPosix.join(cwdPosix, normalizedRaw))
    )
  }

  const primary =
    [...candidates].find((candidate) => isAbsoluteLike(candidate)) ??
    [...candidates][0] ??
    null

  return {
    raw,
    primary,
    candidates: [...candidates].sort(),
    ambiguous: false,
  }
}

function getToolPathArgument(args: any): unknown {
  if (!args || typeof args !== 'object') {
    return undefined
  }

  if (typeof args.path === 'string') {
    return args.path
  }

  if (typeof args.file === 'string') {
    return args.file
  }

  return undefined
}

function summarizeToolArgs(
  toolName: string,
  args: any,
  pathInfo: NormalizedToolPath | null
): string {
  if (pathInfo?.raw) {
    return pathInfo.raw
  }

  if (toolName === 'bash' && typeof args?.command === 'string') {
    return args.command
  }

  if (args === undefined) {
    return 'unknown args'
  }

  return JSON.stringify(args).slice(0, 120)
}

function isVerificationCommand(command: unknown): boolean {
  if (typeof command !== 'string') {
    return false
  }

  const normalized = command.trim().toLowerCase()
  if (normalized.length === 0) {
    return false
  }

  const patterns = [
    /(^|\s)(bun|npm|pnpm|yarn)\s+(run\s+)?test(\s|$)/,
    /(^|\s)vitest(\s|$)/,
    /(^|\s)jest(\s|$)/,
    /(^|\s)pytest(\s|$)/,
    /(^|\s)go\s+test(\s|$)/,
    /(^|\s)cargo\s+(test|check|clippy)(\s|$)/,
    /(^|\s)tsc(\s|$).*--noemit/,
    /(^|\s)eslint(\s|$)/,
    /(^|\s)ruff\s+check(\s|$)/,
  ]

  return patterns.some((pattern) => pattern.test(normalized))
}

function classifyVerificationOutcome(message: any): 'fail' | 'pass' | null {
  const firstLine = extractFirstTextLine(message?.content).toLowerCase()

  if (message?.isError === true || firstLine.startsWith('fail')) {
    return 'fail'
  }

  if (firstLine.startsWith('pass')) {
    return 'pass'
  }

  if (message?.isError === false) {
    return 'pass'
  }

  return null
}

function extractFirstTextLine(content: any): string {
  if (!Array.isArray(content)) {
    return ''
  }

  let text = ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      text += block.text
      if (text.includes('\n')) {
        break
      }
    }
  }

  return text.split('\n')[0]?.trim() ?? ''
}

function isPlanOrProgressArtifact(pathInfo: NormalizedToolPath): boolean {
  return pathInfo.candidates.some((candidate) => {
    const normalized = candidate.toLowerCase()
    const base = normalized.split('/').at(-1) ?? normalized
    return (
      base === 'progress.md' ||
      base === 'plan.md' ||
      base.endsWith('.plan.md') ||
      normalized.includes('/progress/') ||
      normalized.includes('/plans/')
    )
  })
}

function summarizeReasons(
  items: DCPPinnedItemDetail[]
): Record<string, number> {
  const summary: Record<string, number> = {}

  for (const item of items) {
    for (const reason of item.reasons) {
      if (reason.startsWith('protected file pattern')) {
        continue
      }
      summary[reason] = (summary[reason] ?? 0) + 1
    }
  }

  return summary
}

function comparePinnedItems(
  left: DCPPinnedItemDetail,
  right: DCPPinnedItemDetail
): number {
  if (left.turnAge !== right.turnAge) {
    return left.turnAge - right.turnAge
  }

  if (left.stepAge !== right.stepAge) {
    return left.stepAge - right.stepAge
  }

  const toolCompare = left.toolName.localeCompare(right.toolName)
  if (toolCompare !== 0) {
    return toolCompare
  }

  return left.argsSummary.localeCompare(right.argsSummary)
}

function globToRegExp(pattern: string): RegExp {
  const normalized = toPosixPath(pattern.trim())
  let regex = '^'

  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index]
    const next = normalized[index + 1]

    if (char === '*' && next === '*') {
      const following = normalized[index + 2]
      if (following === '/') {
        regex += '(?:.*/)?'
        index += 2
      } else {
        regex += '.*'
        index += 1
      }
      continue
    }

    if (char === '*') {
      regex += '[^/]*'
      continue
    }

    if (char === '?') {
      regex += '[^/]'
      continue
    }

    regex += escapeRegExp(char)
  }

  regex += '$'
  return new RegExp(regex)
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/')
}

function normalizePosixPath(value: string): string {
  return pathPosix.normalize(value)
}

function stripLeadingCurrentDir(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value
}

function addPathCandidate(candidates: Set<string>, value: string): void {
  const cleaned = stripTrailingSlash(value)
  if (!cleaned || cleaned === '.') {
    return
  }

  candidates.add(cleaned)
}

function stripTrailingSlash(value: string): string {
  if (value.length <= 1) {
    return value
  }

  return value.endsWith('/') ? value.slice(0, -1) : value
}

function isAbsoluteLike(value: string): boolean {
  return value.startsWith('/') || /^[a-z]:\//i.test(value)
}
