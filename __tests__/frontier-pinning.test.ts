import { expect, test } from 'bun:test'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import { mergeConfig } from '../config'
import { handleContextTransform } from '../hooks/context-transform'
import { buildDetailsMarkdown } from '../observability'
import { createProtectionPolicy } from '../protection'
import { createSessionState } from '../state'
import { applySupersedeWrites } from '../strategies/supersede-writes'
import { buildToolCallIndex } from '../utils'
import {
  createSingleTurnAutonomousRunFixture,
  expectFrontierPreserved,
  expectStalePayloadPruned,
} from './fixtures/long-run'

function user(content: string, timestamp: number): AgentMessage {
  return { role: 'user', content, timestamp } as any
}

function assistantToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
  timestamp: number
): AgentMessage {
  return {
    role: 'assistant',
    content: [
      {
        type: 'toolCall',
        id,
        name,
        arguments: args,
      },
    ],
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
  timestamp: number,
  isError = false
): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    isError,
    timestamp,
  } as any
}

function transformContext() {
  return {
    getContextUsage: () => ({ tokens: 90, contextWindow: 100 }),
    ui: {
      setStatus: () => {},
    },
  } as any
}

test('protectedFilePatterns keep matching read outputs out of large-output pruning', () => {
  const messages: AgentMessage[] = [
    user('Capture the release plan', 1),
    assistantToolCall('read_1', 'read', { path: 'docs/release.plan.md' }, 2),
    toolResult(
      'read_1',
      'read',
      '# Release Plan\n\n' +
        'Ship the deterministic frontier pinning pass. '.repeat(20),
      3
    ),
    user('Switch tasks', 4),
    user('Ship it', 5),
  ]

  const config = mergeConfig({
    turnProtection: { enabled: true, turns: 2 },
    protectedFilePatterns: ['**/*.plan.md'],
    strategies: {
      deduplicate: { enabled: false },
      purgeErrors: { enabled: false, minTurnAge: 99 },
      outputBodyReplace: { enabled: true, minChars: 80 },
      supersedeWrites: { enabled: false },
    },
  } as any)
  const state = createSessionState(config)

  handleContextTransform(messages, config, state, transformContext())

  expect((messages[2] as any).content[0].text).toContain('Release Plan')
  expect(state.stats.prunedItemsCount.outputBodyReplace).toBe(0)
  expect(
    state.observability.strategyDecisions.outputBodyReplace.skippedProtected
  ).toBe(1)
})

test('protectedFilePatterns keep write arguments intact when supersedeWrites would otherwise prune them', () => {
  const messages: AgentMessage[] = [
    assistantToolCall(
      'write_1',
      'write',
      {
        path: 'docs/release.plan.md',
        content: '# Release Plan\n\n' + 'Preserve this plan body. '.repeat(20),
      },
      1
    ),
    toolResult('write_1', 'write', 'wrote docs/release.plan.md', 2),
    assistantToolCall('read_1', 'read', { path: 'docs/release.plan.md' }, 3),
    toolResult(
      'read_1',
      'read',
      '# Release Plan\n\nPinned after the write.',
      4
    ),
  ]

  const config = mergeConfig({
    turnProtection: { enabled: false, turns: 0 },
    stepProtection: { enabled: false, steps: 0 },
    protectedFilePatterns: ['**/*.plan.md'],
    strategies: {
      deduplicate: { enabled: false },
      purgeErrors: { enabled: false, minTurnAge: 99 },
      outputBodyReplace: { enabled: false, minChars: 9999 },
      supersedeWrites: { enabled: true },
    },
  } as any)
  const state = createSessionState(config)
  const policy = createProtectionPolicy(messages, config)

  applySupersedeWrites(
    messages,
    config,
    state,
    buildToolCallIndex(messages),
    policy
  )

  expect((messages[0] as any).content[0].arguments.content).toContain(
    'Preserve this plan body.'
  )
  expect(state.stats.prunedItemsCount.supersedeWrites).toBe(0)
  expect(
    state.observability.strategyDecisions.supersedeWrites.skippedProtected
  ).toBe(1)
})

test('frontier pinning preserves the latest modified-file read plus the latest failing and successful verification outputs', () => {
  const fixture = createSingleTurnAutonomousRunFixture()
  const latestFail = fixture.stalePayloads.find(
    (ref) => ref.key === 'verification-fail-2'
  )
  const olderFail = fixture.stalePayloads.find(
    (ref) => ref.key === 'verification-fail-1'
  )
  const olderReads = fixture.stalePayloads.filter(
    (ref) => ref.toolName === 'read'
  )

  expect(latestFail).toBeDefined()
  expect(olderFail).toBeDefined()
  expect(olderReads).toHaveLength(2)

  const config = mergeConfig({
    turnProtection: { enabled: false, turns: 0 },
    stepProtection: { enabled: false, steps: 0 },
    protectedFilePatterns: [],
    strategies: {
      deduplicate: { enabled: false },
      purgeErrors: { enabled: true, minTurnAge: 0 },
      outputBodyReplace: { enabled: true, minChars: 80 },
      supersedeWrites: { enabled: false },
    },
  } as any)
  const state = createSessionState(config)

  handleContextTransform(fixture.messages, config, state, transformContext())

  expectFrontierPreserved(fixture.messages, fixture.frontier)
  expectFrontierPreserved(fixture.messages, [latestFail!])
  expectStalePayloadPruned(fixture.messages, [olderFail!], {
    replacementMatcher: /^\[DCP:/,
  })
  expectStalePayloadPruned(fixture.messages, olderReads, {
    replacementMatcher: /^\[DCP:/,
  })

  const detail = buildDetailsMarkdown(config, state)
  expect(detail).toContain('latest read of modified file')
  expect(detail).toContain('latest failing verification output')
  expect(detail).toContain('latest successful verification output')
})

test('frontier pinning keeps the latest plan/progress-style artifact visible even without protectedFilePatterns', () => {
  const messages: AgentMessage[] = [
    user('Track the rollout artifacts', 1),
    assistantToolCall('read_1', 'read', { path: 'notes/release.plan.md' }, 2),
    toolResult(
      'read_1',
      'read',
      '# Release Plan\n\n' + 'Old rollout details. '.repeat(20),
      3
    ),
    assistantToolCall('read_2', 'read', { path: 'src/parser.ts' }, 4),
    toolResult(
      'read_2',
      'read',
      'export function parse() {\n' +
        '  return scan(tokens)\n'.repeat(20) +
        '}',
      5
    ),
    assistantToolCall('read_3', 'read', { path: 'notes/release.plan.md' }, 6),
    toolResult(
      'read_3',
      'read',
      '# Release Plan\n\n' + 'Newest rollout details. '.repeat(20),
      7
    ),
    assistantToolCall(
      'read_4',
      'read',
      { path: 'src/progress-reporter.ts' },
      8
    ),
    toolResult(
      'read_4',
      'read',
      'export function renderProgress() {\n' +
        '  return line\n'.repeat(20) +
        '}',
      9
    ),
  ]

  const config = mergeConfig({
    turnProtection: { enabled: false, turns: 0 },
    stepProtection: { enabled: false, steps: 0 },
    protectedFilePatterns: [],
    strategies: {
      deduplicate: { enabled: false },
      purgeErrors: { enabled: false, minTurnAge: 99 },
      outputBodyReplace: { enabled: true, minChars: 80 },
      supersedeWrites: { enabled: false },
    },
  } as any)
  const state = createSessionState(config)

  handleContextTransform(messages, config, state, transformContext())

  expect((messages[2] as any).content[0].text).toMatch(/^\[DCP:/)
  expect((messages[4] as any).content[0].text).toMatch(/^\[DCP:/)
  expect((messages[6] as any).content[0].text).toContain(
    'Newest rollout details'
  )
  expect((messages[8] as any).content[0].text).toMatch(/^\[DCP:/)

  const detail = buildDetailsMarkdown(config, state)
  expect(detail).toContain('current plan/progress-style artifact')
  expect(detail).toContain('notes/release.plan.md')
})
