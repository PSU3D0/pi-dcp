import { createHash } from 'node:crypto'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { StepSlice } from './types'

type ToolCallBlock = {
  type: 'toolCall'
  id: string
  name: string
  arguments: any
}

type AgeModel = {
  turnAges: number[]
  stepAges: number[]
  steps: StepSlice[]
}

// A turn is defined as one user prompt (user message + subsequent assistant/tool messages)
// We assign a "turn index" to each message, where higher is newer, or we count backwards.
export function computeTurnAges(messages: AgentMessage[]): number[] {
  const ages = new Array(messages.length).fill(0)
  let currentTurnAge = 0

  // Iterate backwards. Every time we see a UserMessage, we increment the turn age for messages BEFORE it.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    ages[i] = currentTurnAge
    if (msg.role === 'user') {
      currentTurnAge++
    }
  }
  return ages
}

export function segmentExecutionSteps(messages: AgentMessage[]): StepSlice[] {
  const steps: Omit<StepSlice, 'age'>[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]

    if (msg.role === 'user') {
      i++
      continue
    }

    if (msg.role === 'assistant') {
      const toolCalls = getToolCallBlocks(msg)

      if (toolCalls.length > 0) {
        let end = i
        let cursor = i + 1
        const toolCallIds = toolCalls.map((block) => block.id)
        const toolCallNames = toolCalls.map((block) => block.name)
        const toolCallIdSet = new Set(toolCallIds)

        while (cursor < messages.length) {
          const next = messages[cursor]
          if (
            next.role === 'toolResult' &&
            typeof next.toolCallId === 'string' &&
            toolCallIdSet.has(next.toolCallId)
          ) {
            end = cursor
            cursor++
            continue
          }
          break
        }

        end = extendStepToImmediateAssistantFollowUp(messages, cursor, end)

        steps.push({
          index: steps.length,
          kind: 'tool',
          start: i,
          end,
          toolCallIds,
          toolNames: toolCallNames,
        })

        i = end + 1
        continue
      }

      if (isExecutionProgressAssistantMessage(messages, i)) {
        steps.push({
          index: steps.length,
          kind: 'assistant',
          start: i,
          end: i,
          toolCallIds: [],
          toolNames: [],
        })
      }

      i++
      continue
    }

    if (msg.role === 'toolResult') {
      let end = i
      let cursor = i
      const toolCallIds: string[] = []
      const toolNames: string[] = []

      while (cursor < messages.length) {
        const next = messages[cursor]
        if (next.role !== 'toolResult') break

        if (typeof next.toolCallId === 'string') {
          toolCallIds.push(next.toolCallId)
        }
        if (typeof next.toolName === 'string') {
          toolNames.push(next.toolName)
        }
        end = cursor
        cursor++
      }

      end = extendStepToImmediateAssistantFollowUp(messages, cursor, end)

      steps.push({
        index: steps.length,
        kind: 'orphanToolResult',
        start: i,
        end,
        toolCallIds,
        toolNames,
      })

      i = end + 1
      continue
    }

    i++
  }

  const newestStepIndex = steps.length - 1

  return steps.map((step, index) => ({
    ...step,
    age: newestStepIndex - index,
  }))
}

export function computeStepAges(
  messages: AgentMessage[],
  steps = segmentExecutionSteps(messages)
): number[] {
  const ages = new Array(messages.length).fill(-1)

  for (const step of steps) {
    for (let i = step.start; i <= step.end; i++) {
      ages[i] = step.age
    }
  }

  return ages
}

export function buildAgeModel(messages: AgentMessage[]): AgeModel {
  const steps = segmentExecutionSteps(messages)
  return {
    turnAges: computeTurnAges(messages),
    stepAges: computeStepAges(messages, steps),
    steps,
  }
}

export function buildToolCallIndex(messages: AgentMessage[]): Map<string, any> {
  const index = new Map<string, any>()
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const block of msg.content) {
        if (block.type === 'toolCall') {
          index.set(block.id, block.arguments)
        }
      }
    }
  }
  return index
}

export function getToolSignature(
  toolName: string,
  args: any,
  _toolCallId: string
): string {
  // Sort keys for consistent hashing.
  // We intentionally avoid a process-global cache here so large raw arguments
  // are not retained across transforms.
  const normalized = normalizeAndSort(args)
  const payload = JSON.stringify({ name: toolName, args: normalized })

  return createHash('sha256').update(payload).digest('hex')
}

export function getToolSignatureCacheEntryCountForTests(): number {
  return 0
}

function normalizeAndSort(obj: any): any {
  if (typeof obj !== 'object' || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(normalizeAndSort)

  const sorted: any = {}
  for (const key of Object.keys(obj).sort()) {
    const value = obj[key]
    if (value !== undefined && value !== null) {
      sorted[key] = normalizeAndSort(value)
    }
  }
  return sorted
}

export function estimateTokens(contentBlocks: any[]): number {
  let chars = 0
  for (const block of contentBlocks) {
    if (block.type === 'text') chars += block.text.length
  }
  return Math.floor(chars / 4)
}

function extendStepToImmediateAssistantFollowUp(
  messages: AgentMessage[],
  cursor: number,
  end: number
): number {
  // Absorb only one immediate text-only assistant follow-up by design so later
  // assistant progress/planning messages remain distinct steps. Terminal/final
  // assistant replies stay outside the execution-step model.
  if (isExecutionProgressAssistantMessage(messages, cursor)) {
    return cursor
  }
  return end
}

function getToolCallBlocks(message: AgentMessage): ToolCallBlock[] {
  if (message.role !== 'assistant') return []

  const blocks: ToolCallBlock[] = []
  for (const block of message.content) {
    if (
      block.type === 'toolCall' &&
      typeof block.id === 'string' &&
      typeof block.name === 'string'
    ) {
      blocks.push(block)
    }
  }
  return blocks
}

function isExecutionProgressAssistantMessage(
  messages: AgentMessage[],
  index: number
): boolean {
  return (
    isAssistantTextOnlyMessage(messages[index]) &&
    hasFutureExecutionActivityBeforeNextUser(messages, index + 1)
  )
}

function hasFutureExecutionActivityBeforeNextUser(
  messages: AgentMessage[],
  startIndex: number
): boolean {
  for (let i = startIndex; i < messages.length; i++) {
    const message = messages[i]

    if (message.role === 'user') {
      return false
    }

    if (message.role === 'toolResult') {
      return true
    }

    if (message.role === 'assistant' && getToolCallBlocks(message).length > 0) {
      return true
    }
  }

  return false
}

function isAssistantTextOnlyMessage(
  message: AgentMessage | undefined
): boolean {
  if (!message || message.role !== 'assistant') return false

  let hasVisibleText = false

  for (const block of message.content) {
    if (block.type === 'toolCall') {
      return false
    }

    if (
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.trim().length > 0
    ) {
      hasVisibleText = true
    }
  }

  return hasVisibleText
}
