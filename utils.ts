import { createHash } from 'node:crypto'
import type { AgentMessage } from '@mariozechner/pi-agent-core'

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

const signatureCache = new Map<string, string>()

export function getToolSignature(
  toolName: string,
  args: any,
  toolCallId: string
): string {
  if (signatureCache.has(toolCallId)) {
    return signatureCache.get(toolCallId)!
  }

  // Sort keys for consistent hashing
  const normalized = normalizeAndSort(args)
  const payload = JSON.stringify({ name: toolName, args: normalized })
  const hash = createHash('sha256').update(payload).digest('hex')

  signatureCache.set(toolCallId, hash)
  return hash
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
