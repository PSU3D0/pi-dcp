import { expect, test } from 'bun:test'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import { createProtectionPolicy } from '../protection'
import type { DCPConfig } from '../types'

function user(content: string, timestamp: number): AgentMessage {
  return { role: 'user', content, timestamp } as any
}

function assistant(content: any[], timestamp: number): AgentMessage {
  return {
    role: 'assistant',
    content,
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: {} as any,
    stopReason: 'stop',
    timestamp,
  } as any
}

function toolResult(
  toolCallId: string,
  toolName: string,
  text: string,
  timestamp: number
): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp,
  } as any
}

function mockConfig(overrides: Partial<DCPConfig> = {}): DCPConfig {
  const base: DCPConfig = {
    enabled: true,
    mode: 'safe',
    debug: false,
    turnProtection: { enabled: true, turns: 8 },
    stepProtection: { enabled: true, steps: 2 },
    thresholds: { nudge: 0.7, autoPrune: 0.8, forceCompact: 0.9 },
    protectedTools: ['todo'],
    protectedFilePatterns: [],
    strategies: {
      deduplicate: { enabled: true },
      purgeErrors: { enabled: true, minTurnAge: 3 },
      outputBodyReplace: { enabled: true, minChars: 10 },
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

test('default hybrid protection stays conservative for short current-turn read loops', () => {
  const messages: AgentMessage[] = [
    user('Inspect the file a few times', 1),
    assistant(
      [
        {
          type: 'toolCall',
          id: 'read_1',
          name: 'read',
          arguments: { path: 'a.ts' },
        },
      ],
      2
    ),
    toolResult('read_1', 'read', 'first current-turn read', 3),
    assistant(
      [
        {
          type: 'toolCall',
          id: 'read_2',
          name: 'read',
          arguments: { path: 'a.ts' },
        },
      ],
      4
    ),
    toolResult('read_2', 'read', 'second current-turn read', 5),
    assistant(
      [
        {
          type: 'toolCall',
          id: 'read_3',
          name: 'read',
          arguments: { path: 'a.ts' },
        },
      ],
      6
    ),
    toolResult('read_3', 'read', 'third current-turn read', 7),
  ]

  const policy = createProtectionPolicy(messages, mockConfig())

  expect(policy.get(2)).toMatchObject({
    protected: true,
    viaTurnWindow: true,
    viaStepWindow: false,
  })
  expect(policy.get(4)).toMatchObject({
    protected: true,
    viaTurnWindow: true,
    viaStepWindow: false,
  })
  expect(policy.get(6)).toMatchObject({
    protected: true,
    viaTurnWindow: true,
    viaStepWindow: false,
  })
})

test('hybrid protection uses the step window after a long current turn while preserving recent prior turns', () => {
  const messages: AgentMessage[] = [
    user('First request', 1),
    assistant(
      [
        {
          type: 'toolCall',
          id: 'read_1',
          name: 'read',
          arguments: { path: 'a.ts' },
        },
      ],
      2
    ),
    toolResult('read_1', 'read', 'older prior-turn read', 3),
    user('Keep going', 4),
    assistant(
      [
        {
          type: 'toolCall',
          id: 'read_2',
          name: 'read',
          arguments: { path: 'b.ts' },
        },
      ],
      5
    ),
    toolResult('read_2', 'read', 'older current-turn read', 6),
    assistant(
      [
        {
          type: 'toolCall',
          id: 'grep_1',
          name: 'grep',
          arguments: { pattern: 'token', path: 'b.ts' },
        },
      ],
      7
    ),
    toolResult('grep_1', 'grep', 'middle current-turn grep', 8),
    assistant(
      [
        {
          type: 'toolCall',
          id: 'read_3',
          name: 'read',
          arguments: { path: 'c.ts' },
        },
      ],
      9
    ),
    toolResult('read_3', 'read', 'newest current-turn read', 10),
  ]

  const policy = createProtectionPolicy(
    messages,
    mockConfig({
      turnProtection: { enabled: true, turns: 2 },
      stepProtection: { enabled: true, steps: 1 },
    })
  )

  expect(policy.get(2)).toMatchObject({
    protected: true,
    viaTurnWindow: true,
    viaStepWindow: false,
  })
  expect(policy.get(5)).toMatchObject({
    protected: false,
    viaTurnWindow: false,
    viaStepWindow: false,
  })
  expect(policy.get(7)).toMatchObject({
    protected: false,
    viaTurnWindow: false,
    viaStepWindow: false,
  })
  expect(policy.get(9)).toMatchObject({
    protected: true,
    viaTurnWindow: false,
    viaStepWindow: true,
  })
})

test('hybrid protection still honors protected tools even when they are outside the active step window', () => {
  const messages: AgentMessage[] = [
    user('Audit todos', 1),
    assistant(
      [
        {
          type: 'toolCall',
          id: 'todo_1',
          name: 'todo',
          arguments: { action: 'list' },
        },
      ],
      2
    ),
    toolResult('todo_1', 'todo', 'older todo payload', 3),
    assistant(
      [
        {
          type: 'toolCall',
          id: 'grep_1',
          name: 'grep',
          arguments: { pattern: 'TODO', path: '.' },
        },
      ],
      4
    ),
    toolResult('grep_1', 'grep', 'newest grep payload', 5),
  ]

  const policy = createProtectionPolicy(
    messages,
    mockConfig({
      turnProtection: { enabled: true, turns: 1 },
      stepProtection: { enabled: true, steps: 1 },
    })
  )

  expect(policy.get(2)).toMatchObject({
    protected: true,
    viaToolProtection: true,
  })
  expect(policy.get(4)).toMatchObject({
    protected: true,
    viaStepWindow: true,
  })
})
