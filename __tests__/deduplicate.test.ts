import { test, expect } from 'bun:test'
import { computeTurnAges, buildToolCallIndex, estimateTokens } from '../utils'
import { applyDeduplicate } from '../strategies/deduplicate'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { DCPConfig } from '../types'
import { createSessionState } from '../state'

function mockConfig(): DCPConfig {
  return {
    enabled: true,
    mode: 'safe',
    debug: false,
    turnProtection: { enabled: true, turns: 2 }, // Only protect the last 2 turns
    thresholds: { nudge: 0.7, autoPrune: 0.8, forceCompact: 0.9 },
    protectedTools: ['todo'],
    protectedFilePatterns: [],
    strategies: {
      deduplicate: { enabled: true },
      purgeErrors: { enabled: false, minTurnAge: 3 },
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

test('computeTurnAges assigns 0 to the last user turn and increments backwards', () => {
  const messages: AgentMessage[] = [
    { role: 'user', content: 'first', timestamp: 1 } as any, // Turn age: 2
    {
      role: 'assistant',
      content: [],
      api: 'test',
      provider: 'test',
      model: 'test',
      usage: {} as any,
      stopReason: 'stop',
      timestamp: 2,
    }, // Turn age: 1
    { role: 'user', content: 'second', timestamp: 3 } as any, // Turn age: 1
    {
      role: 'assistant',
      content: [],
      api: 'test',
      provider: 'test',
      model: 'test',
      usage: {} as any,
      stopReason: 'stop',
      timestamp: 4,
    }, // Turn age: 0
    { role: 'user', content: 'third', timestamp: 5 } as any, // Turn age: 0
  ]

  const ages = computeTurnAges(messages)
  expect(ages).toEqual([2, 2, 1, 1, 0])
})

test('applyDeduplicate prunes older duplicate non-protected tools', () => {
  const messages: AgentMessage[] = [
    { role: 'user', content: 't1', timestamp: 1 } as any,
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
      api: 't',
      provider: 't',
      model: 't',
      usage: {} as any,
      stopReason: 'stop',
      timestamp: 2,
    },
    {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'read',
      content: [{ type: 'text', text: 'long old text' }],
      isError: false,
      timestamp: 3,
    },

    // some other turns to age out call_1
    { role: 'user', content: 't2', timestamp: 4 } as any,
    { role: 'user', content: 't3', timestamp: 5 } as any,
    { role: 'user', content: 't4', timestamp: 6 } as any,

    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call_2',
          name: 'read',
          arguments: { path: 'a.txt' },
        },
      ],
      api: 't',
      provider: 't',
      model: 't',
      usage: {} as any,
      stopReason: 'stop',
      timestamp: 7,
    },
    {
      role: 'toolResult',
      toolCallId: 'call_2',
      toolName: 'read',
      content: [{ type: 'text', text: 'long new text' }],
      isError: false,
      timestamp: 8,
    },
  ]

  const config = mockConfig()
  const state = createSessionState()
  const index = buildToolCallIndex(messages)
  const ages = computeTurnAges(messages)

  applyDeduplicate(messages, config, state, index, ages)

  // call_2 is recent, so it should be kept
  expect((messages[7] as any).content).toEqual([
    { type: 'text', text: 'long new text' },
  ])

  // call_1 is an exact duplicate and is aged out (turn age 3), so it should be pruned
  expect((messages[2] as any).content).toEqual([
    {
      type: 'text',
      text: '[DCP: Exact duplicate of a later tool call. Pruned to save tokens.]',
    },
  ])
  expect(state.stats.prunedItemsCount.deduplicate).toBe(1)
})

test('applyDeduplicate does NOT prune protected tools', () => {
  const messages: AgentMessage[] = [
    { role: 'user', content: 't1', timestamp: 1 } as any,
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call_1',
          name: 'todo',
          arguments: { action: 'list' },
        },
      ],
      api: 't',
      provider: 't',
      model: 't',
      usage: {} as any,
      stopReason: 'stop',
      timestamp: 2,
    },
    {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'todo',
      content: [{ type: 'text', text: 'old list' }],
      isError: false,
      timestamp: 3,
    },

    { role: 'user', content: 't2', timestamp: 4 } as any,
    { role: 'user', content: 't3', timestamp: 5 } as any,
    { role: 'user', content: 't4', timestamp: 6 } as any,

    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call_2',
          name: 'todo',
          arguments: { action: 'list' },
        },
      ],
      api: 't',
      provider: 't',
      model: 't',
      usage: {} as any,
      stopReason: 'stop',
      timestamp: 7,
    },
    {
      role: 'toolResult',
      toolCallId: 'call_2',
      toolName: 'todo',
      content: [{ type: 'text', text: 'new list' }],
      isError: false,
      timestamp: 8,
    },
  ]

  const config = mockConfig()
  const state = createSessionState()
  const index = buildToolCallIndex(messages)
  const ages = computeTurnAges(messages)

  applyDeduplicate(messages, config, state, index, ages)

  // Both should be kept because 'todo' is protected
  expect((messages[2] as any).content).toEqual([
    { type: 'text', text: 'old list' },
  ])
  expect((messages[7] as any).content).toEqual([
    { type: 'text', text: 'new list' },
  ])
  expect(state.stats.protectedSkipCount).toBe(2)
})
