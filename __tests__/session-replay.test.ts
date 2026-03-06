import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import {
  extractEmbeddedSubagentMessages,
  extractSessionMessages,
  formatReplaySummary,
  parseSessionJsonl,
  replaySession,
} from '../session-replay'

function makeTempSessionFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dcp-session-replay-'))
  const path = join(dir, name)
  writeFileSync(path, SESSION_TEXT)
  return path
}

function makeTempReplayConfig(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dcp-session-replay-config-'))
  const path = join(dir, name)
  writeFileSync(
    path,
    JSON.stringify({
      turnProtection: { enabled: false, turns: 0 },
      stepProtection: { enabled: false, steps: 0 },
      strategies: {
        outputBodyReplace: { enabled: true, minChars: 10 },
      },
    })
  )
  return path
}

const SESSION_TEXT = [
  JSON.stringify({
    type: 'message',
    id: 'user-1',
    message: {
      role: 'user',
      content: 'inspect the repo',
      timestamp: 1,
    },
  }),
  JSON.stringify({
    type: 'message',
    id: 'assistant-1',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'read-1',
          name: 'read',
          arguments: { path: 'src/index.ts' },
        },
      ],
      api: 'test',
      provider: 'test',
      model: 'test',
      usage: {} as any,
      stopReason: 'toolUse',
      timestamp: 2,
    },
  }),
  JSON.stringify({
    type: 'message',
    id: 'tool-1',
    message: {
      role: 'toolResult',
      toolCallId: 'read-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'A'.repeat(1600) }],
      isError: false,
      timestamp: 3,
    },
  }),
  JSON.stringify({
    type: 'message',
    id: 'subagent-wrapper',
    message: {
      role: 'toolResult',
      toolName: 'subagent',
      toolCallId: 'subagent-1',
      content: [{ type: 'text', text: '(no output)' }],
      details: {
        results: [
          {
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: 'review the package' }],
                timestamp: 10,
              },
              {
                role: 'assistant',
                content: [
                  {
                    type: 'toolCall',
                    id: 'embedded-read',
                    name: 'read',
                    arguments: { path: 'README.md' },
                  },
                ],
                api: 'test',
                provider: 'test',
                model: 'test',
                usage: {} as any,
                stopReason: 'toolUse',
                timestamp: 11,
              },
              {
                role: 'toolResult',
                toolCallId: 'embedded-read',
                toolName: 'read',
                content: [{ type: 'text', text: 'B'.repeat(1800) }],
                isError: false,
                timestamp: 12,
              },
            ] satisfies AgentMessage[],
          },
        ],
      },
      timestamp: 13,
    },
  }),
].join('\n')

test('extractSessionMessages respects a JSONL head line', () => {
  const entries = parseSessionJsonl(SESSION_TEXT)
  const extracted = extractSessionMessages(entries, { headLine: 3 })

  expect(extracted.selectedEntryLine).toBe(3)
  expect(extracted.messages).toHaveLength(3)
  expect(extracted.messages.at(-1)?.role).toBe('toolResult')
})

test('extractEmbeddedSubagentMessages returns embedded child messages', () => {
  const entries = parseSessionJsonl(SESSION_TEXT)
  const extracted = extractEmbeddedSubagentMessages(entries, 4, 0)

  expect(extracted.selectedEntryLine).toBe(4)
  expect(extracted.messages).toHaveLength(3)
  expect(extracted.messages[1].role).toBe('assistant')
  expect((extracted.messages[2] as any).toolName).toBe('read')
})

test('replaySession applies real DCP transforms to a normal session head', () => {
  const tempPath = makeTempSessionFile('session.jsonl')
  const configPath = makeTempReplayConfig('dcp.json')

  const summary = replaySession({
    sessionPath: tempPath,
    configPath,
    headLine: 3,
    pressure: {
      band: 'low',
    },
  })

  expect(summary.source.kind).toBe('session')
  expect(summary.counts.originalMessages).toBe(3)
  expect(summary.counts.tokensSavedEstimate).toBeGreaterThan(0)
  expect(
    summary.prunedItems.some((item) => item.strategy === 'outputBodyReplace')
  ).toBe(true)
  expect((summary.transformedMessages[2] as any).content[0].text).toContain(
    '[DCP: Large output'
  )
})

test('replaySession can replay an embedded subagent transcript', () => {
  const tempPath = makeTempSessionFile('subagent.jsonl')
  const configPath = makeTempReplayConfig('dcp.json')

  const summary = replaySession({
    sessionPath: tempPath,
    configPath,
    subagentLine: 4,
    pressure: {
      band: 'low',
    },
  })

  expect(summary.source.kind).toBe('embedded-subagent')
  expect(summary.counts.originalMessages).toBe(3)
  expect(summary.prunedItems.some((item) => item.toolName === 'read')).toBe(
    true
  )
})

test('formatReplaySummary renders readable markdown headings', () => {
  const tempPath = makeTempSessionFile('format.jsonl')

  const summary = replaySession({
    sessionPath: tempPath,
    headLine: 3,
    pressure: {
      band: 'high',
    },
  })

  const markdown = formatReplaySummary(summary)
  expect(markdown).toContain('# DCP Session Replay')
  expect(markdown).toContain('## Pruned Items')
  expect(markdown).toContain('Pressure: high')
})
