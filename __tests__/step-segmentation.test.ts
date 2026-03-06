import { expect, test } from 'bun:test'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import { buildAgeModel, computeStepAges, segmentExecutionSteps } from '../utils'

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

test('segmentExecutionSteps splits multiple tool cycles inside one user turn', () => {
  const messages: AgentMessage[] = [
    user('Do the work', 1),
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
    toolResult('read_1', 'read', 'file contents', 3),
    assistant([{ type: 'text', text: 'I found the issue.' }], 4),
    assistant(
      [
        {
          type: 'toolCall',
          id: 'grep_1',
          name: 'grep',
          arguments: { pattern: 'stepAge', path: 'a.ts' },
        },
      ],
      5
    ),
    toolResult('grep_1', 'grep', 'matched lines', 6),
    assistant([{ type: 'text', text: 'I know what to change next.' }], 7),
    user('Thanks', 8),
  ]

  const steps = segmentExecutionSteps(messages)

  expect(steps).toEqual([
    {
      index: 0,
      age: 1,
      kind: 'tool',
      start: 1,
      end: 3,
      toolCallIds: ['read_1'],
      toolNames: ['read'],
    },
    {
      index: 1,
      age: 0,
      kind: 'tool',
      start: 4,
      end: 5,
      toolCallIds: ['grep_1'],
      toolNames: ['grep'],
    },
  ])
  expect(computeStepAges(messages, steps)).toEqual([-1, 1, 1, 1, 0, 0, -1, -1])
})

test('segmentExecutionSteps includes text-only assistant progress steps', () => {
  const messages: AgentMessage[] = [
    user('Investigate', 1),
    assistant([{ type: 'text', text: 'Planning the approach.' }], 2),
    assistant([{ type: 'text', text: 'Still reasoning about the fix.' }], 3),
    assistant(
      [
        {
          type: 'toolCall',
          id: 'bash_1',
          name: 'bash',
          arguments: { command: 'npm test -- step-age' },
        },
      ],
      4
    ),
    toolResult('bash_1', 'bash', '1 failing test', 5),
    assistant([{ type: 'text', text: 'The failure is isolated.' }], 6),
  ]

  const steps = segmentExecutionSteps(messages)

  expect(steps).toEqual([
    {
      index: 0,
      age: 2,
      kind: 'assistant',
      start: 1,
      end: 1,
      toolCallIds: [],
      toolNames: [],
    },
    {
      index: 1,
      age: 1,
      kind: 'assistant',
      start: 2,
      end: 2,
      toolCallIds: [],
      toolNames: [],
    },
    {
      index: 2,
      age: 0,
      kind: 'tool',
      start: 3,
      end: 4,
      toolCallIds: ['bash_1'],
      toolNames: ['bash'],
    },
  ])
  expect(computeStepAges(messages, steps)).toEqual([-1, 2, 1, 0, 0, -1])
})

test('segmentExecutionSteps ignores thinking-only assistant messages', () => {
  const messages: AgentMessage[] = [
    user('Investigate further', 1),
    assistant(
      [{ type: 'thinking', text: 'Need to inspect the failing step.' }] as any,
      2
    ),
    assistant(
      [
        {
          type: 'toolCall',
          id: 'read_1',
          name: 'read',
          arguments: { path: 'utils.ts' },
        },
      ],
      3
    ),
    toolResult('read_1', 'read', 'utils.ts contents', 4),
    assistant([{ type: 'thinking', text: 'The helper is close.' }] as any, 5),
    assistant(
      [{ type: 'text', text: 'The helper needs a stricter text check.' }],
      6
    ),
  ]

  const steps = segmentExecutionSteps(messages)

  expect(steps).toEqual([
    {
      index: 0,
      age: 0,
      kind: 'tool',
      start: 2,
      end: 3,
      toolCallIds: ['read_1'],
      toolNames: ['read'],
    },
  ])
  expect(computeStepAges(messages, steps)).toEqual([-1, -1, 0, 0, -1, -1])
})

test('segmentExecutionSteps does not treat plain conversational assistant replies as execution steps', () => {
  const messages: AgentMessage[] = [
    user('What changed?', 1),
    assistant(
      [{ type: 'text', text: 'I updated the helper and reran the tests.' }],
      2
    ),
  ]

  expect(segmentExecutionSteps(messages)).toEqual([])
  expect(computeStepAges(messages)).toEqual([-1, -1])
})

test('segmentExecutionSteps ignores standalone final assistant replies after autonomous work ends', () => {
  const messages: AgentMessage[] = [
    user('Fix the helper', 1),
    assistant(
      [
        {
          type: 'text',
          text: 'First I will inspect the current implementation.',
        },
      ],
      2
    ),
    assistant(
      [
        {
          type: 'toolCall',
          id: 'read_1',
          name: 'read',
          arguments: { path: 'utils.ts' },
        },
      ],
      3
    ),
    toolResult('read_1', 'read', 'utils.ts contents', 4),
    assistant(
      [{ type: 'text', text: 'The fix is in place and tests are green.' }],
      5
    ),
  ]

  expect(segmentExecutionSteps(messages)).toEqual([
    {
      index: 0,
      age: 1,
      kind: 'assistant',
      start: 1,
      end: 1,
      toolCallIds: [],
      toolNames: [],
    },
    {
      index: 1,
      age: 0,
      kind: 'tool',
      start: 2,
      end: 3,
      toolCallIds: ['read_1'],
      toolNames: ['read'],
    },
  ])
  expect(computeStepAges(messages)).toEqual([-1, 1, 0, 0, -1])
})

test('segmentExecutionSteps keeps multi-tool assistant calls and their results together', () => {
  const messages: AgentMessage[] = [
    user('Inspect the repo', 1),
    assistant(
      [
        {
          type: 'toolCall',
          id: 'read_1',
          name: 'read',
          arguments: { path: 'utils.ts' },
        },
        {
          type: 'toolCall',
          id: 'grep_1',
          name: 'grep',
          arguments: { pattern: 'computeStepAges', path: '.' },
        },
      ],
      2
    ),
    toolResult('read_1', 'read', 'utils.ts contents', 3),
    toolResult('grep_1', 'grep', 'one match', 4),
    assistant([{ type: 'text', text: 'Both results point at utils.ts.' }], 5),
    user('Continue', 6),
  ]

  const steps = segmentExecutionSteps(messages)

  expect(steps).toEqual([
    {
      index: 0,
      age: 0,
      kind: 'tool',
      start: 1,
      end: 3,
      toolCallIds: ['read_1', 'grep_1'],
      toolNames: ['read', 'grep'],
    },
  ])
  expect(computeStepAges(messages, steps)).toEqual([-1, 0, 0, 0, -1, -1])
})

test('segmentExecutionSteps handles orphaned tool results from older compacted history', () => {
  const messages: AgentMessage[] = [
    toolResult('old_read_1', 'read', 'older compacted payload', 1),
    toolResult('old_grep_1', 'grep', 'older compacted match list', 2),
    assistant(
      [{ type: 'text', text: 'Earlier tool-call messages were compacted.' }],
      3
    ),
    user('Resume from here', 4),
    assistant(
      [
        {
          type: 'toolCall',
          id: 'read_2',
          name: 'read',
          arguments: { path: 'types.ts' },
        },
      ],
      5
    ),
    toolResult('read_2', 'read', 'fresh payload', 6),
  ]

  const steps = segmentExecutionSteps(messages)

  expect(steps).toEqual([
    {
      index: 0,
      age: 1,
      kind: 'orphanToolResult',
      start: 0,
      end: 1,
      toolCallIds: ['old_read_1', 'old_grep_1'],
      toolNames: ['read', 'grep'],
    },
    {
      index: 1,
      age: 0,
      kind: 'tool',
      start: 4,
      end: 5,
      toolCallIds: ['read_2'],
      toolNames: ['read'],
    },
  ])
  expect(computeStepAges(messages, steps)).toEqual([1, 1, -1, -1, 0, 0])
})

test('segmentExecutionSteps skips malformed orphan tool-result metadata fields', () => {
  const messages: AgentMessage[] = [
    {
      role: 'toolResult',
      content: [{ type: 'text', text: 'missing identifiers' }],
      isError: false,
      timestamp: 1,
    } as any,
    {
      role: 'toolResult',
      toolCallId: 'grep_1',
      content: [{ type: 'text', text: 'missing tool name' }],
      isError: false,
      timestamp: 2,
    } as any,
    {
      role: 'toolResult',
      toolName: 'read',
      content: [{ type: 'text', text: 'missing call id' }],
      isError: false,
      timestamp: 3,
    } as any,
    assistant([{ type: 'text', text: 'Recovered from compacted history.' }], 4),
  ]

  expect(segmentExecutionSteps(messages)).toEqual([
    {
      index: 0,
      age: 0,
      kind: 'orphanToolResult',
      start: 0,
      end: 2,
      toolCallIds: ['grep_1'],
      toolNames: ['read'],
    },
  ])
})

test('buildAgeModel keeps turn ages intact while layering step ages', () => {
  const messages: AgentMessage[] = [
    user('Investigate', 1),
    assistant(
      [
        {
          type: 'toolCall',
          id: 'read_1',
          name: 'read',
          arguments: { path: 'utils.ts' },
        },
      ],
      2
    ),
    toolResult('read_1', 'read', 'utils.ts contents', 3),
    assistant([{ type: 'text', text: 'I found the relevant helper.' }], 4),
    user('Continue', 5),
    assistant([{ type: 'text', text: 'Planning the next change.' }], 6),
    assistant(
      [
        {
          type: 'toolCall',
          id: 'grep_1',
          name: 'grep',
          arguments: { pattern: 'buildAgeModel', path: 'utils.ts' },
        },
      ],
      7
    ),
    toolResult('grep_1', 'grep', '1 match', 8),
    assistant([{ type: 'text', text: 'Ready to patch it.' }], 9),
  ]

  expect(buildAgeModel(messages)).toEqual({
    turnAges: [1, 1, 1, 1, 0, 0, 0, 0, 0],
    stepAges: [-1, 2, 2, -1, -1, 1, 0, 0, -1],
    steps: [
      {
        index: 0,
        age: 2,
        kind: 'tool',
        start: 1,
        end: 2,
        toolCallIds: ['read_1'],
        toolNames: ['read'],
      },
      {
        index: 1,
        age: 1,
        kind: 'assistant',
        start: 5,
        end: 5,
        toolCallIds: [],
        toolNames: [],
      },
      {
        index: 2,
        age: 0,
        kind: 'tool',
        start: 6,
        end: 7,
        toolCallIds: ['grep_1'],
        toolNames: ['grep'],
      },
    ],
  })
})

test('step-age helpers handle empty message arrays', () => {
  expect(segmentExecutionSteps([])).toEqual([])
  expect(computeStepAges([])).toEqual([])
  expect(buildAgeModel([])).toEqual({
    turnAges: [],
    stepAges: [],
    steps: [],
  })
})
