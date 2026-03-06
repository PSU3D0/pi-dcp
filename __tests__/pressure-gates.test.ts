import { expect, test } from 'bun:test'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import { handleDcpCommand } from '../commands/dcp'
import { mergeConfig } from '../config'
import { handleContextTransform } from '../hooks/context-transform'
import { createSessionState } from '../state'

function makeTransformContext(tokens: number, contextWindow: number) {
  const statusCalls: Array<{ key: string; value: string | undefined }> = []

  return {
    statusCalls,
    ctx: {
      getContextUsage: () => ({ tokens, contextWindow }),
      ui: {
        setStatus: (key: string, value: string | undefined) => {
          statusCalls.push({ key, value })
        },
      },
    } as any,
  }
}

function makeCommandContext() {
  const notifications: Array<{ message: string; level: string }> = []

  return {
    notifications,
    ctx: {
      ui: {
        notify: (message: string, level: string) => {
          notifications.push({ message, level })
        },
        editor: () => {},
      },
    } as any,
  }
}

function makeAgedPayloadMessages(): AgentMessage[] {
  return [
    { role: 'user', content: 't1', timestamp: 1 } as any,
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call_read_1',
          name: 'read',
          arguments: { path: 'src/index.ts' },
        },
      ],
      api: 'test',
      provider: 'test',
      model: 'test',
      usage: {} as any,
      stopReason: 'stop',
      timestamp: 2,
    },
    {
      role: 'toolResult',
      toolCallId: 'call_read_1',
      toolName: 'read',
      content: [{ type: 'text', text: 'This is a massive file content!' }],
      isError: false,
      timestamp: 3,
    },
    {
      role: 'toolResult',
      toolCallId: 'call_bash_1',
      toolName: 'bash',
      content: [
        {
          type: 'text',
          text: 'Error: stale verification failure\nstack line 1\nstack line 2',
        },
      ],
      isError: true,
      timestamp: 4,
    },
    { role: 'user', content: 't2', timestamp: 5 } as any,
    { role: 'user', content: 't3', timestamp: 6 } as any,
    { role: 'user', content: 't4', timestamp: 7 } as any,
  ]
}

function makeSupersededWriteMessages(): AgentMessage[] {
  return [
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
      api: 'test',
      provider: 'test',
      model: 'test',
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
      api: 'test',
      provider: 'test',
      model: 'test',
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
}

test('low pressure preserves baseline large-output replacement and stale-error trimming', () => {
  const config = mergeConfig({
    turnProtection: { turns: 2 },
    strategies: {
      deduplicate: { enabled: false },
      purgeErrors: { enabled: true, minTurnAge: 3 },
      outputBodyReplace: { enabled: true, minChars: 10 },
      supersedeWrites: { enabled: false },
    },
  } as any)
  const state = createSessionState(config)
  const transform = makeTransformContext(60, 100)
  const messages = makeAgedPayloadMessages()

  handleContextTransform(messages, config, state, transform.ctx)

  expect(state.observability.pressure.band).toBe('low')
  expect(state.observability.pressure.effectiveBand).toBe('low')
  expect((messages[2] as any).content[0].text).toContain(
    '[DCP: Large output from read({"path":"src/index.ts"}...) pruned due to age (Turn 3)'
  )
  expect((messages[3] as any).content[0].text).toBe(
    '[DCP: Stale error payload minimized.]\nError: stale verification failure...'
  )
  expect(state.stats.prunedItemsCount.outputBodyReplace).toBe(1)
  expect(state.stats.prunedItemsCount.purgeErrors).toBe(1)
})

test('medium pressure keeps the same baseline replacement behavior while high-only pruning stays off', () => {
  const config = mergeConfig({
    turnProtection: { turns: 2 },
    strategies: {
      deduplicate: { enabled: false },
      purgeErrors: { enabled: true, minTurnAge: 3 },
      outputBodyReplace: { enabled: true, minChars: 10 },
      supersedeWrites: { enabled: false },
    },
  } as any)
  const state = createSessionState(config)
  const transform = makeTransformContext(75, 100)
  const messages = makeAgedPayloadMessages()

  handleContextTransform(messages, config, state, transform.ctx)

  expect(state.observability.pressure.band).toBe('medium')
  expect(state.observability.pressure.effectiveBand).toBe('medium')
  expect((messages[2] as any).content[0].text).toContain(
    '[DCP: Large output from read({"path":"src/index.ts"}...) pruned due to age (Turn 3)'
  )
  expect((messages[3] as any).content[0].text).toBe(
    '[DCP: Stale error payload minimized.]\nError: stale verification failure...'
  )
  expect(state.stats.prunedItemsCount.outputBodyReplace).toBe(1)
  expect(state.stats.prunedItemsCount.purgeErrors).toBe(1)
  expect(transform.statusCalls.at(-1)?.value).toContain(
    'medium pre-prune pressure'
  )
  expect(transform.statusCalls.at(-1)?.value).toContain('baseline safe wins')
})

test('high pressure unlocks superseded-write pruning while medium pressure keeps it off', () => {
  const config = mergeConfig({
    turnProtection: { enabled: false, turns: 0 },
    stepProtection: { enabled: false, steps: 0 },
    strategies: {
      deduplicate: { enabled: false },
      purgeErrors: { enabled: false, minTurnAge: 99 },
      outputBodyReplace: { enabled: false, minChars: 1200 },
      supersedeWrites: { enabled: true },
    },
  } as any)

  const mediumState = createSessionState(config)
  const mediumMessages = makeSupersededWriteMessages()
  handleContextTransform(
    mediumMessages,
    config,
    mediumState,
    makeTransformContext(75, 100).ctx
  )

  expect(mediumState.observability.pressure.band).toBe('medium')
  expect((mediumMessages[0] as any).content[0].arguments.content).toBe(
    'huge string'
  )
  expect(mediumState.stats.prunedItemsCount.supersedeWrites).toBe(0)

  const highState = createSessionState(config)
  const highMessages = makeSupersededWriteMessages()
  handleContextTransform(
    highMessages,
    config,
    highState,
    makeTransformContext(85, 100).ctx
  )

  expect(highState.observability.pressure.band).toBe('high')
  expect(highState.observability.pressure.effectiveBand).toBe('high')
  expect((highMessages[0] as any).content[0].arguments.content).toBe(
    '[DCP: Content superseded by later read]'
  )
  expect(highState.stats.prunedItemsCount.supersedeWrites).toBe(1)
})

test('critical pressure status reports the effective band meaning without attempting compaction yet', () => {
  const config = mergeConfig({
    turnProtection: { turns: 2 },
    strategies: {
      deduplicate: { enabled: false },
      purgeErrors: { enabled: true, minTurnAge: 3 },
      outputBodyReplace: { enabled: true, minChars: 10 },
      supersedeWrites: { enabled: true },
    },
  } as any)
  const state = createSessionState(config)
  const transform = makeTransformContext(95, 100)

  handleContextTransform(
    makeAgedPayloadMessages(),
    config,
    state,
    transform.ctx
  )

  expect(state.observability.pressure.band).toBe('critical')
  expect(state.observability.pressure.effectiveBand).toBe('critical')
  expect(transform.statusCalls.at(-1)?.value).toContain(
    'critical pre-prune pressure'
  )
  expect(transform.statusCalls.at(-1)?.value).toContain('compaction preferred')

  const command = makeCommandContext()
  handleDcpCommand('status', command.ctx, config, state)

  expect(command.notifications).toHaveLength(1)
  expect(command.notifications[0].message).toContain('Effective band: critical')
  expect(command.notifications[0].message).toContain(
    'prefer compaction coordination'
  )
})
