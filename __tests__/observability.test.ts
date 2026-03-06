import { test, expect } from 'bun:test'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import { getDefaultConfig, mergeConfig } from '../config'
import { createSessionState } from '../state'
import { handleContextTransform } from '../hooks/context-transform'
import { handleDcpCommand } from '../commands/dcp'
import { computePressureState } from '../observability'

function makeMessages(): AgentMessage[] {
  return [
    { role: 'user', content: 'Investigate', timestamp: 1 } as any,
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call_1',
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
      toolCallId: 'call_1',
      toolName: 'read',
      content: [{ type: 'text', text: 'small output' }],
      isError: false,
      timestamp: 3,
    },
    { role: 'user', content: 'Continue', timestamp: 4 } as any,
  ]
}

function makeLargeOutputMessages(): AgentMessage[] {
  return [
    { role: 'user', content: 'Investigate', timestamp: 1 } as any,
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call_1',
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
      toolCallId: 'call_1',
      toolName: 'read',
      content: [{ type: 'text', text: 'This is a massive file content!' }],
      isError: false,
      timestamp: 3,
    },
    { role: 'user', content: 'Continue', timestamp: 4 } as any,
    { role: 'user', content: 'Ship it', timestamp: 5 } as any,
  ]
}

function makeProtectedDuplicateMessages(): AgentMessage[] {
  return [
    { role: 'user', content: 'First', timestamp: 1 } as any,
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
      api: 'test',
      provider: 'test',
      model: 'test',
      usage: {} as any,
      stopReason: 'stop',
      timestamp: 2,
    },
    {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'todo',
      content: [
        { type: 'text', text: 'protected old list with extra payload' },
      ],
      isError: false,
      timestamp: 3,
    },
    { role: 'user', content: 'Second', timestamp: 4 } as any,
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
      api: 'test',
      provider: 'test',
      model: 'test',
      usage: {} as any,
      stopReason: 'stop',
      timestamp: 5,
    },
    {
      role: 'toolResult',
      toolCallId: 'call_2',
      toolName: 'todo',
      content: [
        { type: 'text', text: 'protected new list with extra payload' },
      ],
      isError: false,
      timestamp: 6,
    },
    { role: 'user', content: 'Third', timestamp: 7 } as any,
  ]
}

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
  const editors: Array<{ title: string; content: string }> = []

  return {
    notifications,
    editors,
    ctx: {
      ui: {
        notify: (message: string, level: string) => {
          notifications.push({ message, level })
        },
        editor: (title: string, content: string) => {
          editors.push({ title, content })
        },
      },
    } as any,
  }
}

test('mergeConfig applies overrides without mutating defaults', () => {
  const merged = mergeConfig({
    mode: 'advanced',
    thresholds: { autoPrune: 0.86 },
    turnProtection: { turns: 4 },
    protectedFilePatterns: ['**/*.ops.md'],
    strategies: { supersedeWrites: { enabled: true } },
    advanced: { llmAutonomy: true },
  } as any)

  expect(merged.mode).toBe('advanced')
  expect(merged.thresholds.nudge).toBe(0.7)
  expect(merged.thresholds.autoPrune).toBe(0.86)
  expect(merged.thresholds.forceCompact).toBe(0.9)
  expect(merged.turnProtection.enabled).toBe(true)
  expect(merged.turnProtection.turns).toBe(4)
  expect(merged.stepProtection.enabled).toBe(true)
  expect(merged.stepProtection.steps).toBe(2)
  expect(merged.protectedFilePatterns).toEqual(['**/*.ops.md'])
  expect(merged.strategies.deduplicate.enabled).toBe(true)
  expect(merged.strategies.supersedeWrites.enabled).toBe(true)
  expect(merged.advanced.distillTool.enabled).toBe(false)
  expect(merged.advanced.llmAutonomy).toBe(true)

  const defaults = getDefaultConfig()
  expect(defaults.mode).toBe('safe')
  expect(defaults.turnProtection.turns).toBe(8)
  expect(defaults.stepProtection).toEqual({ enabled: true, steps: 2 })
  expect(defaults.thresholds.autoPrune).toBe(0.8)
  expect(defaults.protectedFilePatterns).toEqual([
    '**/CHANGELOG.md',
    '**/*.plan.md',
    '**/progress.md',
  ])
  expect(defaults.strategies.supersedeWrites.enabled).toBe(false)
  expect(defaults.advanced.llmAutonomy).toBe(false)
})

test('computePressureState classifies low, medium, high, and critical bands', () => {
  const config = getDefaultConfig()

  expect(
    computePressureState(config, { tokens: 60, contextWindow: 100 }).band
  ).toBe('low')
  expect(
    computePressureState(config, { tokens: 75, contextWindow: 100 }).band
  ).toBe('medium')
  expect(
    computePressureState(config, { tokens: 85, contextWindow: 100 }).band
  ).toBe('high')
  expect(
    computePressureState(config, { tokens: 95, contextWindow: 100 }).band
  ).toBe('critical')
})

test('fresh-session status and details reflect config defaults before any transform runs', () => {
  const config = getDefaultConfig()
  const state = createSessionState(config)
  const command = makeCommandContext()

  handleDcpCommand('status', command.ctx, config, state)
  handleDcpCommand('details', command.ctx, config, state)

  expect(command.notifications).toHaveLength(1)
  const status = command.notifications[0].message
  expect(status).toContain('Mode: safe')
  expect(status).toContain('Pressure: unknown')
  expect(status).toContain('ctx.getContextUsage unavailable')
  expect(status).toContain('Effective band: low')
  expect(status).toContain('baseline safe wins active')
  expect(status).toContain('low-band defaults stay on')
  expect(status).toContain('Protection windows: turns=8')
  expect(status).toContain('steps=2')
  expect(status).toContain('protected tools=5')
  expect(status).toContain('protectedFilePatterns=3 enforced')
  expect(status).toContain('frontierPins=0')
  expect(status).toContain(
    'Config activation: active=turnProtection, protectedTools, protectedFilePatterns, stepProtection, thresholds (pressure gates)'
  )

  expect(command.editors).toHaveLength(1)
  const detail = command.editors[0].content
  expect(detail).toContain('Mode: `safe`')
  expect(detail).toContain('Pressure: unknown')
  expect(detail).toContain('Effective band: low')
  expect(detail).toContain('baseline safe wins active')
  expect(detail).toContain('low-band defaults stay on')
  expect(detail).toContain('Protected tools: 5')
  expect(detail).toContain('protectedFilePatterns: 3 configured, enforced')
  expect(detail).toContain('Frontier pins: 0')
  expect(detail).toContain('Age buckets: (none)')
  expect(detail).toContain('No file/frontier pins in the latest transform.')
  expect(detail).toContain('`deduplicate`: enabled')
  expect(detail).toContain('`purgeErrors`: enabled')
  expect(detail).toContain('`outputBodyReplace`: enabled')
  expect(detail).toContain('active at low+ pressure')
  expect(detail).toContain('`supersedeWrites`: disabled')
})

test('status reports effective thresholds, pressure, protection windows, and inactive config', () => {
  const config = getDefaultConfig()
  const state = createSessionState()
  const transform = makeTransformContext(75, 100)

  handleContextTransform(makeMessages(), config, state, transform.ctx)

  expect(state.observability.pressure.band).toBe('medium')

  const command = makeCommandContext()
  handleDcpCommand('status', command.ctx, config, state)

  expect(command.notifications).toHaveLength(1)
  const message = command.notifications[0].message
  expect(message).toContain('Mode: safe')
  expect(message).toContain('reported only')
  expect(message).toContain('Pressure: medium')
  expect(message).toContain('pre-prune snapshot')
  expect(message).toContain('Effective band: medium')
  expect(message).toContain(
    'baseline safe wins active; no extra high-pressure pruning yet'
  )
  expect(message).toContain('nudge 70%')
  expect(message).toContain('auto-prune 80%')
  expect(message).toContain('force-compact 90%')
  expect(message).toContain('Protection windows: turns=8')
  expect(message).toContain('steps=2')
  expect(message).toContain('protectedFilePatterns=3 enforced')
  expect(message).toContain('frontierPins=0')
  expect(message).toContain('advanced.distillTool')
  expect(message).toContain('Tokens Saved: ~0')
})

test('details output includes overridden config, age buckets, and strategy decisions even with no pruned items', () => {
  const config = mergeConfig({
    mode: 'advanced',
    thresholds: {
      nudge: 0.5,
      autoPrune: 0.6,
      forceCompact: 0.9,
    },
    turnProtection: { turns: 3 },
    protectedFilePatterns: ['**/*.ops.md'],
  } as any)
  const state = createSessionState()
  const transform = makeTransformContext(65, 100)

  handleContextTransform(makeMessages(), config, state, transform.ctx)

  expect(state.observability.pressure.band).toBe('high')

  const command = makeCommandContext()
  handleDcpCommand('details', command.ctx, config, state)

  expect(command.editors).toHaveLength(1)
  const detail = command.editors[0].content
  expect(detail).toContain('Mode: `advanced`')
  expect(detail).toContain('reported, no extra policy branching yet')
  expect(detail).toContain('Pressure: high')
  expect(detail).toContain('pre-prune snapshot')
  expect(detail).toContain('Effective band: high')
  expect(detail).toContain('broader stale payload pruning active')
  expect(detail).toContain(
    'Thresholds: nudge 50%, auto-prune 60%, force-compact 90%'
  )
  expect(detail).toContain('Protection windows: turns=3')
  expect(detail).toContain('protectedFilePatterns: 1 configured, enforced')
  expect(detail).toContain('Frontier pins: 0')
  expect(detail).toContain('Age buckets')
  expect(detail).toContain('Strategy decisions')
  expect(detail).toContain('deduplicate')
  expect(detail).toContain('No items pruned in the latest transform')
})

test('protected skips are counted once per item even when multiple strategies skip the same tool result', () => {
  const config = mergeConfig({
    turnProtection: { turns: 1 },
    protectedTools: ['todo'],
    strategies: {
      deduplicate: { enabled: true },
      outputBodyReplace: { enabled: true, minChars: 10 },
    },
  } as any)
  const state = createSessionState()

  const transform = makeTransformContext(75, 100)

  handleContextTransform(
    makeProtectedDuplicateMessages(),
    config,
    state,
    transform.ctx
  )

  expect(
    state.observability.strategyDecisions.deduplicate.skippedProtected
  ).toBe(2)
  expect(
    state.observability.strategyDecisions.outputBodyReplace.skippedProtected
  ).toBe(2)
  expect(state.stats.protectedSkipCount).toBe(2)
})

test('status and details label pressure as a pre-prune snapshot after pruning runs', () => {
  const config = mergeConfig({
    turnProtection: { turns: 2 },
    strategies: {
      outputBodyReplace: { enabled: true, minChars: 10 },
    },
  } as any)
  const state = createSessionState()
  const transform = makeTransformContext(85, 100)

  handleContextTransform(
    makeLargeOutputMessages(),
    config,
    state,
    transform.ctx
  )

  expect(state.stats.prunedItemsCount.outputBodyReplace).toBe(1)
  expect(transform.statusCalls.at(-1)?.value).toContain(
    'high pre-prune pressure'
  )

  const command = makeCommandContext()
  handleDcpCommand('status', command.ctx, config, state)
  handleDcpCommand('details', command.ctx, config, state)

  expect(command.notifications[0].message).toContain('pre-prune snapshot')
  expect(command.notifications[0].message).toContain('Effective band: high')
  expect(command.editors[0].content).toContain('pre-prune snapshot')
  expect(command.editors[0].content).toContain('Effective band: high')
})
