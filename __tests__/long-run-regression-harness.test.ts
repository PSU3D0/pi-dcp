import { expect, test } from 'bun:test'
import { mergeConfig } from '../config'
import { handleContextTransform } from '../hooks/context-transform'
import { createSessionState } from '../state'
import { buildAgeModel } from '../utils'
import {
  createRepeatedReadsOfModifiedFileFixture,
  createRepeatedVerificationLoopFixture,
  createSingleTurnAutonomousRunFixture,
  createStaleLogsWithFreshFrontierFixture,
  expectFrontierPreserved,
  expectStalePayloadPruned,
  expectTurnOnlyAgingBlindSpot,
} from './fixtures/long-run'

test('single-turn autonomous fixture codifies the pure turn-aging blind spot', () => {
  const fixture = createSingleTurnAutonomousRunFixture()
  const ageModel = buildAgeModel(fixture.messages)

  expect(ageModel.steps.length).toBeGreaterThanOrEqual(8)
  expectTurnOnlyAgingBlindSpot(fixture, ageModel.turnAges, ageModel.stepAges, 1)
})

test('fixture catalog covers repeated verification loops and repeated reads of modified files', () => {
  const verificationFixture = createRepeatedVerificationLoopFixture()
  const repeatedReadFixture = createRepeatedReadsOfModifiedFileFixture()

  expect(
    verificationFixture.messages.filter(
      (message) => message.role === 'toolResult' && message.toolName === 'bash'
    )
  ).toHaveLength(3)
  expect(verificationFixture.stalePayloads).toHaveLength(2)
  expect(verificationFixture.frontier).toHaveLength(1)

  expect(
    repeatedReadFixture.messages.filter(
      (message) => message.role === 'toolResult' && message.toolName === 'read'
    )
  ).toHaveLength(3)
  expect(repeatedReadFixture.stalePayloads).toHaveLength(2)
  expect(repeatedReadFixture.frontier).toHaveLength(1)
})

test('stale payload assertion accepts future tombstones without DCP-specific text', () => {
  const fixture = createRepeatedVerificationLoopFixture()

  for (const ref of fixture.stalePayloads) {
    const messageIndex = fixture.messages.findIndex(
      (message) =>
        message.role === 'toolResult' &&
        message.toolCallId === ref.toolCallId &&
        message.toolName === ref.toolName
    )

    expect(messageIndex).toBeGreaterThanOrEqual(0)

    fixture.messages[messageIndex] = {
      ...(fixture.messages[messageIndex] as any),
      content: [
        {
          type: 'text',
          text: `tombstone: ${ref.description} remains available for replay if needed`,
        },
      ],
    } as any
  }

  expectStalePayloadPruned(fixture.messages, fixture.stalePayloads, {
    replacementMatcher: /^tombstone:/i,
  })
})

test('default hybrid protection stays conservative for short repeated reads under low pressure', () => {
  const fixture = createRepeatedReadsOfModifiedFileFixture()
  const config = mergeConfig({
    strategies: {
      deduplicate: { enabled: false },
      purgeErrors: { enabled: false, minTurnAge: 99 },
      outputBodyReplace: { enabled: true, minChars: 80 },
      supersedeWrites: { enabled: false },
    },
  } as any)
  const state = createSessionState(config)

  handleContextTransform(fixture.messages, config, state, {
    getContextUsage: () => ({ tokens: 60, contextWindow: 100 }),
    ui: {
      setStatus: () => {},
    },
  } as any)

  expect(state.observability.pressure.band).toBe('low')
  expect(state.stats.prunedItemsCount.outputBodyReplace).toBe(0)
  expectFrontierPreserved(fixture.messages, fixture.stalePayloads)
  expectFrontierPreserved(fixture.messages, fixture.frontier)
})

test('tracked long-run artifacts resolve by tool call identity after index drift', () => {
  const fixture = createStaleLogsWithFreshFrontierFixture()
  const shiftedMessages = structuredClone(fixture.messages)

  shiftedMessages.splice(0, 0, {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Injected progress note before fixture replay.' },
    ],
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: {} as any,
    stopReason: 'stop',
    timestamp: 0,
  } as any)

  for (const ref of fixture.stalePayloads) {
    const messageIndex = shiftedMessages.findIndex(
      (message) =>
        message.role === 'toolResult' &&
        message.toolCallId === ref.toolCallId &&
        message.toolName === ref.toolName
    )

    expect(messageIndex).toBeGreaterThanOrEqual(0)

    shiftedMessages[messageIndex] = {
      ...(shiftedMessages[messageIndex] as any),
      content: [
        {
          type: 'text',
          text: `pruned tombstone for ${ref.key}`,
        },
      ],
    } as any
  }

  expectStalePayloadPruned(shiftedMessages, fixture.stalePayloads, {
    replacementMatcher: /pruned tombstone/i,
  })
  expectFrontierPreserved(shiftedMessages, fixture.frontier)
})

test('hybrid protection prunes stale payloads inside one user turn while preserving the frontier', () => {
  const fixture = createSingleTurnAutonomousRunFixture()
  const config = mergeConfig({
    turnProtection: { turns: 8 },
    stepProtection: { enabled: true, steps: 2 },
    strategies: {
      deduplicate: { enabled: false },
      purgeErrors: { enabled: false, minTurnAge: 99 },
      outputBodyReplace: { enabled: true, minChars: 80 },
      supersedeWrites: { enabled: false },
    },
  } as any)
  const state = createSessionState(config)

  handleContextTransform(fixture.messages, config, state, {
    getContextUsage: () => ({ tokens: 85, contextWindow: 100 }),
    ui: {
      setStatus: () => {},
    },
  } as any)

  const latestFail = fixture.stalePayloads.find(
    (ref) => ref.key === 'verification-fail-2'
  )
  const prunableStalePayloads = fixture.stalePayloads.filter(
    (ref) => ref.key !== 'verification-fail-2'
  )

  expect(latestFail).toBeDefined()
  expect(state.stats.prunedItemsCount.outputBodyReplace).toBeGreaterThanOrEqual(
    prunableStalePayloads.length
  )
  expectStalePayloadPruned(fixture.messages, prunableStalePayloads, {
    replacementMatcher: /^\[DCP:/,
  })
  expectFrontierPreserved(fixture.messages, fixture.frontier)
  expectFrontierPreserved(fixture.messages, [latestFail!])
})

test('stale giant logs fixture supports shared preserved-vs-pruned assertions', () => {
  const fixture = createStaleLogsWithFreshFrontierFixture()
  const config = mergeConfig({
    turnProtection: { turns: 1 },
    strategies: {
      deduplicate: { enabled: false },
      purgeErrors: { enabled: false, minTurnAge: 99 },
      outputBodyReplace: { enabled: true, minChars: 120 },
      supersedeWrites: { enabled: false },
    },
  } as any)
  const state = createSessionState(config)

  handleContextTransform(fixture.messages, config, state, {
    getContextUsage: () => ({ tokens: 85, contextWindow: 100 }),
    ui: {
      setStatus: () => {},
    },
  } as any)

  const latestFail = fixture.stalePayloads.find(
    (ref) => ref.key === 'old-verification-log'
  )
  const prunableStalePayloads = fixture.stalePayloads.filter(
    (ref) => ref.key !== 'old-verification-log'
  )

  expect(latestFail).toBeDefined()
  expect(state.stats.prunedItemsCount.outputBodyReplace).toBe(
    prunableStalePayloads.length
  )
  expectStalePayloadPruned(fixture.messages, prunableStalePayloads, {
    replacementMatcher: /^\[DCP:/,
  })
  expectFrontierPreserved(fixture.messages, fixture.frontier)
  expectFrontierPreserved(fixture.messages, [latestFail!])
})
