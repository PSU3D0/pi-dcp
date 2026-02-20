import { test, expect } from 'bun:test'
import { applySupersedeWrites } from '../strategies/supersede-writes'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { DCPConfig } from '../types'
import { createSessionState } from '../state'
import { buildToolCallIndex } from '../utils'

function mockConfig(): DCPConfig {
  return {
    enabled: true,
    mode: 'safe',
    debug: false,
    turnProtection: { enabled: true, turns: 2 },
    thresholds: { nudge: 0.7, autoPrune: 0.8, forceCompact: 0.9 },
    protectedTools: [],
    protectedFilePatterns: [],
    strategies: {
      deduplicate: { enabled: false },
      purgeErrors: { enabled: false, minTurnAge: 3 },
      outputBodyReplace: { enabled: false, minChars: 1200 },
      supersedeWrites: { enabled: true },
    },
    advanced: {
      distillTool: { enabled: false },
      compressTool: { enabled: false },
      llmAutonomy: false,
    },
  }
}

test('applySupersedeWrites prunes write arguments if superseded by later read', () => {
  const messages: AgentMessage[] = [
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'write_1',
          name: 'write',
          arguments: { path: 'a.txt', content: 'huge string' },
        },
      ],
      api: '',
      provider: '',
      model: '',
      usage: {} as any,
      stopReason: 'stop',
      timestamp: 1,
    },
    {
      role: 'toolResult',
      toolCallId: 'write_1',
      toolName: 'write',
      content: [],
      isError: false,
      timestamp: 2,
    },

    // Some time passes...

    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'read_1',
          name: 'read',
          arguments: { path: 'a.txt' },
        },
      ],
      api: '',
      provider: '',
      model: '',
      usage: {} as any,
      stopReason: 'stop',
      timestamp: 3,
    },
    {
      role: 'toolResult',
      toolCallId: 'read_1',
      toolName: 'read',
      content: [],
      isError: false,
      timestamp: 4,
    },
  ]

  const config = mockConfig()
  const state = createSessionState()
  const index = buildToolCallIndex(messages)

  applySupersedeWrites(messages, config, state, index)

  // The write should be pruned
  expect((messages[0] as any).content[0].arguments.content).toBe(
    '[DCP: Content superseded by later read]'
  )
  expect(state.stats.prunedItemsCount.supersedeWrites).toBe(1)
})

test('applySupersedeWrites does NOT prune writes if no later read exists', () => {
  const messages: AgentMessage[] = [
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'write_1',
          name: 'write',
          arguments: { path: 'b.txt', content: 'huge string' },
        },
      ],
      api: '',
      provider: '',
      model: '',
      usage: {} as any,
      stopReason: 'stop',
      timestamp: 1,
    },
    {
      role: 'toolResult',
      toolCallId: 'write_1',
      toolName: 'write',
      content: [],
      isError: false,
      timestamp: 2,
    },

    // Different file read
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'read_1',
          name: 'read',
          arguments: { path: 'c.txt' },
        },
      ],
      api: '',
      provider: '',
      model: '',
      usage: {} as any,
      stopReason: 'stop',
      timestamp: 3,
    },
    {
      role: 'toolResult',
      toolCallId: 'read_1',
      toolName: 'read',
      content: [],
      isError: false,
      timestamp: 4,
    },
  ]

  const config = mockConfig()
  const state = createSessionState()
  const index = buildToolCallIndex(messages)

  applySupersedeWrites(messages, config, state, index)

  // The write should be kept intact
  expect((messages[0] as any).content[0].arguments.content).toBe('huge string')
  expect(state.stats.prunedItemsCount.supersedeWrites).toBe(0)
})
