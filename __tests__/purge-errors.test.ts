import { test, expect } from 'bun:test'
import { computeTurnAges, estimateTokens } from '../utils'
import { applyPurgeErrors } from '../strategies/purge-errors'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { DCPConfig } from '../types'
import { createSessionState } from '../state'

function mockConfig(): DCPConfig {
  return {
    enabled: true,
    mode: 'safe',
    debug: false,
    turnProtection: { enabled: true, turns: 2 },
    thresholds: { nudge: 0.7, autoPrune: 0.8, forceCompact: 0.9 },
    protectedTools: ['todo'],
    protectedFilePatterns: [],
    strategies: {
      deduplicate: { enabled: false },
      purgeErrors: { enabled: true, minTurnAge: 3 },
      outputBodyReplace: { enabled: false, minChars: 1200 },
      supersedeWrites: { enabled: false },
    },
    advanced: {
      distillTool: { enabled: false },
      compressTool: { enabled: false },
      llmAutonomy: false,
    },
  }
}

test('applyPurgeErrors minimizes old errors', () => {
  const messages: AgentMessage[] = [
    { role: 'user', content: 't1', timestamp: 1 } as any, // age 3
    {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'read',
      content: [{ type: 'text', text: 'Error: file not found\nline2\nline3' }],
      isError: true,
      timestamp: 3,
    }, // age 3

    { role: 'user', content: 't2', timestamp: 4 } as any, // age 2
    { role: 'user', content: 't3', timestamp: 5 } as any, // age 1
    { role: 'user', content: 't4', timestamp: 6 } as any, // age 0
  ]

  const config = mockConfig()
  const state = createSessionState()
  const ages = computeTurnAges(messages)

  applyPurgeErrors(messages, config, state, ages)

  expect((messages[1] as any).content[0].text).toBe(
    '[DCP: Stale error payload minimized.]\nError: file not found...'
  )
  expect(state.stats.prunedItemsCount.purgeErrors).toBe(1)
})

test('applyPurgeErrors preserves recent errors', () => {
  const messages: AgentMessage[] = [
    { role: 'user', content: 't1', timestamp: 1 } as any, // age 2
    {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'read',
      content: [{ type: 'text', text: 'Error: recent' }],
      isError: true,
      timestamp: 3,
    }, // age 2

    { role: 'user', content: 't2', timestamp: 4 } as any, // age 1
    { role: 'user', content: 't3', timestamp: 5 } as any, // age 0
  ]

  const config = mockConfig()
  const state = createSessionState()
  const ages = computeTurnAges(messages)

  applyPurgeErrors(messages, config, state, ages)

  expect((messages[1] as any).content[0].text).toBe('Error: recent')
  expect(state.stats.prunedItemsCount.purgeErrors).toBe(0)
})
