import { test, expect } from 'bun:test'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { DCPConfig } from '../types'
import { createProtectionPolicy } from '../protection'
import { createSessionState } from '../state'
import { applyPurgeErrors } from '../strategies/purge-errors'

function mockConfig(overrides: Partial<DCPConfig> = {}): DCPConfig {
  const base: DCPConfig = {
    enabled: true,
    mode: 'safe',
    debug: false,
    turnProtection: { enabled: true, turns: 2 },
    stepProtection: { enabled: true, steps: 2 },
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

  return {
    ...base,
    ...overrides,
    turnProtection: { ...base.turnProtection, ...overrides.turnProtection },
    stepProtection: { ...base.stepProtection, ...overrides.stepProtection },
    thresholds: { ...base.thresholds, ...overrides.thresholds },
    strategies: {
      deduplicate: {
        ...base.strategies.deduplicate,
        ...overrides.strategies?.deduplicate,
      },
      purgeErrors: {
        ...base.strategies.purgeErrors,
        ...overrides.strategies?.purgeErrors,
      },
      outputBodyReplace: {
        ...base.strategies.outputBodyReplace,
        ...overrides.strategies?.outputBodyReplace,
      },
      supersedeWrites: {
        ...base.strategies.supersedeWrites,
        ...overrides.strategies?.supersedeWrites,
      },
    },
    advanced: {
      distillTool: {
        ...base.advanced.distillTool,
        ...overrides.advanced?.distillTool,
      },
      compressTool: {
        ...base.advanced.compressTool,
        ...overrides.advanced?.compressTool,
      },
      llmAutonomy: overrides.advanced?.llmAutonomy ?? base.advanced.llmAutonomy,
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
  const policy = createProtectionPolicy(messages, config)

  applyPurgeErrors(messages, config, state, policy)

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
  const policy = createProtectionPolicy(messages, config)

  applyPurgeErrors(messages, config, state, policy)

  expect((messages[1] as any).content[0].text).toBe('Error: recent')
  expect(state.stats.prunedItemsCount.purgeErrors).toBe(0)
})

test('applyPurgeErrors still honors minTurnAge after current-turn step protection ages out', () => {
  const messages: AgentMessage[] = [
    { role: 'user', content: 'Fix the parser test', timestamp: 1 } as any,
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'bash_1',
          name: 'bash',
          arguments: { command: 'bun test parser.spec.ts --bail' },
        },
      ],
      api: 'test',
      provider: 'test',
      model: 'test',
      usage: {} as any,
      stopReason: 'stop',
      timestamp: 2,
    } as any,
    {
      role: 'toolResult',
      toolCallId: 'bash_1',
      toolName: 'bash',
      content: [
        {
          type: 'text',
          text: 'Error: first failure\nstack line 1\nstack line 2',
        },
      ],
      isError: true,
      timestamp: 3,
    } as any,
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'bash_2',
          name: 'bash',
          arguments: { command: 'bun test parser.spec.ts --bail' },
        },
      ],
      api: 'test',
      provider: 'test',
      model: 'test',
      usage: {} as any,
      stopReason: 'stop',
      timestamp: 4,
    } as any,
    {
      role: 'toolResult',
      toolCallId: 'bash_2',
      toolName: 'bash',
      content: [
        {
          type: 'text',
          text: 'Error: second failure\nstack line 1\nstack line 2',
        },
      ],
      isError: true,
      timestamp: 5,
    } as any,
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'bash_3',
          name: 'bash',
          arguments: { command: 'bun test parser.spec.ts --bail' },
        },
      ],
      api: 'test',
      provider: 'test',
      model: 'test',
      usage: {} as any,
      stopReason: 'stop',
      timestamp: 6,
    } as any,
    {
      role: 'toolResult',
      toolCallId: 'bash_3',
      toolName: 'bash',
      content: [
        {
          type: 'text',
          text: 'Error: third failure\nstack line 1\nstack line 2',
        },
      ],
      isError: true,
      timestamp: 7,
    } as any,
  ]

  const config = mockConfig({
    turnProtection: { enabled: true, turns: 2 },
    stepProtection: { enabled: true, steps: 1 },
  })
  const state = createSessionState()
  const policy = createProtectionPolicy(messages, config)

  expect(policy.get(2)).toMatchObject({
    protected: false,
    currentTurnExecution: true,
    turnAge: 0,
  })

  applyPurgeErrors(messages, config, state, policy)

  expect((messages[2] as any).content[0].text).toBe(
    'Error: first failure\nstack line 1\nstack line 2'
  )
  expect((messages[4] as any).content[0].text).toBe(
    'Error: second failure\nstack line 1\nstack line 2'
  )
  expect((messages[6] as any).content[0].text).toBe(
    'Error: third failure\nstack line 1\nstack line 2'
  )
  expect(state.stats.prunedItemsCount.purgeErrors).toBe(0)
})
