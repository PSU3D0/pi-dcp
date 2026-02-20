import { test, expect } from 'bun:test'
import { applyOutputBodyReplace } from '../strategies/output-replace'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { DCPConfig } from '../types'
import { createSessionState } from '../state'
import { buildToolCallIndex, computeTurnAges } from '../utils'

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
      purgeErrors: { enabled: false, minTurnAge: 3 },
      outputBodyReplace: { enabled: true, minChars: 10 }, // Tiny threshold for test
      supersedeWrites: { enabled: false },
    },
    advanced: {
      distillTool: { enabled: false },
      compressTool: { enabled: false },
      llmAutonomy: false,
    },
  }
}

test('applyOutputBodyReplace prunes large outputs outside turn protection', () => {
  const messages: AgentMessage[] = [
    { role: 'user', content: 't1', timestamp: 1 } as any, // age 2
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call_1',
          name: 'read',
          arguments: { path: 'a.txt' },
        },
      ],
      api: '',
      provider: '',
      model: '',
      usage: {} as any,
      stopReason: 'stop',
      timestamp: 2,
    },
    {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'read',
      content: [{ type: 'text', text: 'This is a massive file content!' }],
      isError: false,
      timestamp: 3,
    }, // age 2 (will age out)

    { role: 'user', content: 't2', timestamp: 4 } as any, // age 1
    { role: 'user', content: 't3', timestamp: 5 } as any, // age 0
  ]

  const config = mockConfig()
  const state = createSessionState()
  const index = buildToolCallIndex(messages)
  const ages = computeTurnAges(messages)

  applyOutputBodyReplace(messages, config, state, index, ages)

  expect((messages[2] as any).content[0].text).toContain(
    '[DCP: Large output from read({"path":"a.txt"}...) pruned due to age (Turn 2)'
  )
  expect(state.stats.prunedItemsCount.outputBodyReplace).toBe(1)
})

test('applyOutputBodyReplace keeps small outputs', () => {
  const messages: AgentMessage[] = [
    { role: 'user', content: 't1', timestamp: 1 } as any, // age 2
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call_1',
          name: 'read',
          arguments: { path: 'a.txt' },
        },
      ],
      api: '',
      provider: '',
      model: '',
      usage: {} as any,
      stopReason: 'stop',
      timestamp: 2,
    },
    {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'read',
      content: [{ type: 'text', text: 'small' }],
      isError: false,
      timestamp: 3,
    }, // age 2 (aged out, but small)

    { role: 'user', content: 't2', timestamp: 4 } as any, // age 1
    { role: 'user', content: 't3', timestamp: 5 } as any, // age 0
  ]

  const config = mockConfig()
  const state = createSessionState()
  const index = buildToolCallIndex(messages)
  const ages = computeTurnAges(messages)

  applyOutputBodyReplace(messages, config, state, index, ages)

  expect((messages[2] as any).content[0].text).toBe('small')
  expect(state.stats.prunedItemsCount.outputBodyReplace).toBe(0)
})

test('applyOutputBodyReplace keeps recent large outputs', () => {
  const messages: AgentMessage[] = [
    { role: 'user', content: 't1', timestamp: 1 } as any, // age 0
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call_1',
          name: 'read',
          arguments: { path: 'a.txt' },
        },
      ],
      api: '',
      provider: '',
      model: '',
      usage: {} as any,
      stopReason: 'stop',
      timestamp: 2,
    },
    {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'read',
      content: [{ type: 'text', text: 'This is a massive file content!' }],
      isError: false,
      timestamp: 3,
    }, // age 0 (recent)
  ]

  const config = mockConfig()
  const state = createSessionState()
  const index = buildToolCallIndex(messages)
  const ages = computeTurnAges(messages)

  applyOutputBodyReplace(messages, config, state, index, ages)

  expect((messages[2] as any).content[0].text).toBe(
    'This is a massive file content!'
  )
  expect(state.stats.prunedItemsCount.outputBodyReplace).toBe(0)
})
