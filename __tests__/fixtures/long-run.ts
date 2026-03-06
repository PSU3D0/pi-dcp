import { expect } from 'bun:test'
import type { AgentMessage } from '@mariozechner/pi-agent-core'

export interface LongRunArtifactRef {
  key: string
  description: string
  toolCallId: string
  toolName: string
  messageIndex: number
  originalText: string
}

export interface LongRunFixture {
  name: string
  messages: AgentMessage[]
  stalePayloads: LongRunArtifactRef[]
  frontier: LongRunArtifactRef[]
}

export interface PrunedPayloadExpectation {
  replacementMatcher?:
    | string
    | RegExp
    | ((text: string, ref: LongRunArtifactRef) => void)
}

export interface ResolvedToolResult {
  index: number
  message: any
}

type FixtureTrack = 'frontier' | 'stale' | 'neutral'

interface ToolCycleSpec {
  key: string
  description: string
  toolName: string
  args: Record<string, unknown>
  resultText: string
  isError?: boolean
  assistantFollowUp?: string
  trackAs?: FixtureTrack
}

export class LongRunFixtureBuilder {
  private readonly messages: AgentMessage[] = []
  private readonly stalePayloads: LongRunArtifactRef[] = []
  private readonly frontier: LongRunArtifactRef[] = []
  private readonly toolSequenceByName = new Map<string, number>()
  private timestamp = 1

  user(content: string): this {
    this.messages.push({
      role: 'user',
      content,
      timestamp: this.nextTimestamp(),
    } as any)
    return this
  }

  assistantText(text: string): this {
    this.messages.push({
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'test',
      provider: 'test',
      model: 'test',
      usage: {} as any,
      stopReason: 'stop',
      timestamp: this.nextTimestamp(),
    } as any)
    return this
  }

  toolCycle(spec: ToolCycleSpec): LongRunArtifactRef {
    const toolCallId = this.nextToolCallId(spec.toolName)

    this.messages.push({
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: toolCallId,
          name: spec.toolName,
          arguments: spec.args,
        },
      ],
      api: 'test',
      provider: 'test',
      model: 'test',
      usage: {} as any,
      stopReason: 'stop',
      timestamp: this.nextTimestamp(),
    } as any)

    const messageIndex = this.messages.length
    this.messages.push({
      role: 'toolResult',
      toolCallId,
      toolName: spec.toolName,
      content: [{ type: 'text', text: spec.resultText }],
      isError: spec.isError ?? false,
      timestamp: this.nextTimestamp(),
    } as any)

    const ref: LongRunArtifactRef = {
      key: spec.key,
      description: spec.description,
      toolCallId,
      toolName: spec.toolName,
      messageIndex,
      originalText: spec.resultText,
    }

    if (spec.trackAs === 'frontier') {
      this.frontier.push(ref)
    } else if (spec.trackAs === 'stale') {
      this.stalePayloads.push(ref)
    }

    if (spec.assistantFollowUp) {
      this.assistantText(spec.assistantFollowUp)
    }

    return ref
  }

  build(name: string): LongRunFixture {
    return {
      name,
      messages: structuredClone(this.messages),
      stalePayloads: [...this.stalePayloads],
      frontier: [...this.frontier],
    }
  }

  private nextTimestamp(): number {
    return this.timestamp++
  }

  private nextToolCallId(toolName: string): string {
    const nextIndex = (this.toolSequenceByName.get(toolName) ?? 0) + 1
    this.toolSequenceByName.set(toolName, nextIndex)
    return `${toolName}_${nextIndex}`
  }
}

export function createSingleTurnAutonomousRunFixture(): LongRunFixture {
  const builder = new LongRunFixtureBuilder()

  builder
    .user(
      'Fix the parser regression and keep the newest frontier evidence in view.'
    )
    .assistantText(
      'I will inspect the file, rerun the narrow test, and iterate until it passes.'
    )

  builder.toolCycle({
    key: 'initial-parser-read',
    description: 'Initial parser snapshot before any edits.',
    toolName: 'read',
    args: { path: 'src/parser.ts' },
    resultText: parserSnapshot(
      'initial parser snapshot',
      'if (token.type === "escape") return currentNode'
    ),
    trackAs: 'stale',
    assistantFollowUp:
      'The first snapshot shows the escape branch returns too early.',
  })

  builder.toolCycle({
    key: 'verification-fail-1',
    description: 'Old failing verification output from the first rerun.',
    toolName: 'bash',
    args: { command: 'bun test parser.spec.ts --bail' },
    resultText: verificationLog(
      'FAIL parser.spec.ts',
      'escaped braces stop the parser before the close tag is emitted'
    ),
    trackAs: 'stale',
    assistantFollowUp:
      'The first failure confirms the early return is still active.',
  })

  builder.toolCycle({
    key: 'patch-1',
    description: 'First synthetic edit to the parser branch ordering.',
    toolName: 'edit',
    args: {
      path: 'src/parser.ts',
      oldText: 'return currentNode',
      newText: 'continue',
    },
    resultText:
      'Applied edit to src/parser.ts: replaced the early return in the escape branch with a continue.',
    assistantFollowUp:
      'I patched the branch ordering and will reread the file before rerunning tests.',
  })

  builder.toolCycle({
    key: 'post-patch-read-1',
    description: 'Intermediate parser snapshot after the first edit.',
    toolName: 'read',
    args: { path: 'src/parser.ts' },
    resultText: parserSnapshot(
      'parser after patch 1',
      'if (token.type === "escape") { state = "escaped"; continue }'
    ),
    trackAs: 'stale',
    assistantFollowUp:
      'The first reread looks better, but I need another verification loop.',
  })

  builder.toolCycle({
    key: 'verification-fail-2',
    description:
      'Second failing verification output inside the same user turn.',
    toolName: 'bash',
    args: { command: 'bun test parser.spec.ts --bail' },
    resultText: verificationLog(
      'FAIL parser.spec.ts',
      'escaped close tags still collapse into the parent branch when nested'
    ),
    trackAs: 'stale',
    assistantFollowUp: 'One nested edge case remains, so I need a final patch.',
  })

  builder.toolCycle({
    key: 'patch-2',
    description: 'Second synthetic edit that finalizes the parser fix.',
    toolName: 'edit',
    args: {
      path: 'src/parser.ts',
      oldText: 'state = "escaped"',
      newText: 'state = token.isClosing ? "closing-escaped" : "escaped"',
    },
    resultText:
      'Applied edit to src/parser.ts: split the escaped state into closing-escaped and normal escaped branches.',
    assistantFollowUp:
      'The final patch is in place; I will capture the newest file state and verification result.',
  })

  builder.toolCycle({
    key: 'post-patch-read-2',
    description: 'Newest read of the modified parser file.',
    toolName: 'read',
    args: { path: 'src/parser.ts' },
    resultText: parserSnapshot(
      'parser after patch 2',
      'state = token.isClosing ? "closing-escaped" : "escaped"'
    ),
    trackAs: 'frontier',
    assistantFollowUp: 'The newest read reflects the final branch ordering.',
  })

  builder.toolCycle({
    key: 'verification-pass',
    description: 'Latest successful verification output for the parser fix.',
    toolName: 'bash',
    args: { command: 'bun test parser.spec.ts --bail' },
    resultText: verificationLog(
      'PASS parser.spec.ts',
      '4 parser tests passed; escaped braces and escaped closing tags now stay in the correct branch'
    ),
    trackAs: 'frontier',
  })

  builder.assistantText(
    'The parser fix is ready and the latest verification loop is green.'
  )

  return builder.build('single-turn-autonomous-run')
}

export function createRepeatedVerificationLoopFixture(): LongRunFixture {
  const builder = new LongRunFixtureBuilder()

  builder
    .user('Make the parser test stable without changing unrelated formatting.')
    .assistantText(
      'I will rerun the narrow verification loop until the failing edge cases are gone.'
    )

  builder.toolCycle({
    key: 'verification-loop-fail-1',
    description: 'First failing verification result.',
    toolName: 'bash',
    args: { command: 'bun test parser.spec.ts --bail' },
    resultText: verificationLog(
      'FAIL parser.spec.ts',
      'escaped braces stop the parser before the buffered close tag is emitted'
    ),
    trackAs: 'stale',
    assistantFollowUp:
      'The first rerun isolates the buffered close-tag branch.',
  })

  builder.toolCycle({
    key: 'verification-loop-fail-2',
    description: 'Second failing verification result after one attempted fix.',
    toolName: 'bash',
    args: { command: 'bun test parser.spec.ts --bail' },
    resultText: verificationLog(
      'FAIL parser.spec.ts',
      'nested escaped close tags still unwind the stack one frame too early'
    ),
    trackAs: 'stale',
    assistantFollowUp:
      'The second rerun leaves only the nested escaped close-tag case.',
  })

  builder.toolCycle({
    key: 'verification-loop-pass',
    description: 'Latest successful verification result.',
    toolName: 'bash',
    args: { command: 'bun test parser.spec.ts --bail' },
    resultText: verificationLog(
      'PASS parser.spec.ts',
      '4 parser tests passed; no buffered close-tag regressions remain'
    ),
    trackAs: 'frontier',
  })

  builder.assistantText(
    'The verification loop is stable now, so the newest pass is the frontier artifact.'
  )

  return builder.build('repeated-verification-loop')
}

export function createRepeatedReadsOfModifiedFileFixture(): LongRunFixture {
  const builder = new LongRunFixtureBuilder()

  builder
    .user(
      'Keep the progress reporter deterministic while refining the output headings.'
    )
    .assistantText(
      'I will reread the file after each edit so the latest snapshot stays explicit.'
    )

  builder.toolCycle({
    key: 'progress-read-1',
    description: 'Initial read of the progress reporter before edits.',
    toolName: 'read',
    args: { path: 'src/progress-reporter.ts' },
    resultText: progressReporterSnapshot(
      'progress reporter before edits',
      'const heading = "Progress"'
    ),
    trackAs: 'stale',
    assistantFollowUp: 'The initial snapshot shows the old heading constant.',
  })

  builder.toolCycle({
    key: 'progress-edit-1',
    description: 'First synthetic edit to the heading format.',
    toolName: 'edit',
    args: {
      path: 'src/progress-reporter.ts',
      oldText: 'const heading = "Progress"',
      newText: 'const heading = `${section}: progress`',
    },
    resultText:
      'Applied edit to src/progress-reporter.ts: changed the heading constant to a section-aware template.',
    assistantFollowUp:
      'I changed the heading template and will capture the new file contents.',
  })

  builder.toolCycle({
    key: 'progress-read-2',
    description: 'Second read after the first edit.',
    toolName: 'read',
    args: { path: 'src/progress-reporter.ts' },
    resultText: progressReporterSnapshot(
      'progress reporter after edit 1',
      'const heading = `${section}: progress`'
    ),
    trackAs: 'stale',
    assistantFollowUp:
      'The second snapshot confirms the section-aware heading, but I still want a cleaner title case helper.',
  })

  builder.toolCycle({
    key: 'progress-edit-2',
    description: 'Second synthetic edit to normalize title casing.',
    toolName: 'edit',
    args: {
      path: 'src/progress-reporter.ts',
      oldText: 'renderHeading(section, heading)',
      newText: 'renderHeading(toTitleCase(section), heading)',
    },
    resultText:
      'Applied edit to src/progress-reporter.ts: normalized section labels through toTitleCase before rendering.',
    assistantFollowUp:
      'The title-case helper landed; one final read should be the current frontier.',
  })

  builder.toolCycle({
    key: 'progress-read-3',
    description: 'Latest read of the modified progress reporter.',
    toolName: 'read',
    args: { path: 'src/progress-reporter.ts' },
    resultText: progressReporterSnapshot(
      'progress reporter after edit 2',
      'renderHeading(toTitleCase(section), heading)'
    ),
    trackAs: 'frontier',
  })

  builder.assistantText(
    'The third read is the newest file-state artifact and should stay pinned later.'
  )

  return builder.build('repeated-reads-of-modified-file')
}

export function createStaleLogsWithFreshFrontierFixture(): LongRunFixture {
  const builder = new LongRunFixtureBuilder()

  builder
    .user('Investigate the parser regression and capture the failure clearly.')
    .assistantText(
      'I will grab the failing log and the initial file snapshot before making progress.'
    )

  builder.toolCycle({
    key: 'old-verification-log',
    description:
      'Older giant verification log that can be pruned once a newer turn starts.',
    toolName: 'bash',
    args: { command: 'bun test parser.spec.ts --bail' },
    resultText: verificationLog(
      'FAIL parser.spec.ts',
      'escaped braces and nested escaped closing tags both fail in the pre-fix snapshot'
    ),
    trackAs: 'stale',
    assistantFollowUp:
      'The failing verification output is captured; next I will inspect the old parser snapshot.',
  })

  builder.toolCycle({
    key: 'old-parser-read',
    description: 'Older large read output from before the final fix.',
    toolName: 'read',
    args: { path: 'src/parser.ts' },
    resultText: parserSnapshot(
      'parser before final fix',
      'if (token.type === "escape") return currentNode'
    ),
    trackAs: 'stale',
    assistantFollowUp: 'The older file snapshot is now captured in history.',
  })

  builder
    .user('Keep going and finish the parser fix.')
    .assistantText(
      'I will keep the newest file state and latest verification result visible as the frontier.'
    )

  builder.toolCycle({
    key: 'frontier-parser-read',
    description: 'Newest read of the parser after the fix.',
    toolName: 'read',
    args: { path: 'src/parser.ts' },
    resultText: parserSnapshot(
      'parser after final fix',
      'state = token.isClosing ? "closing-escaped" : "escaped"'
    ),
    trackAs: 'frontier',
    assistantFollowUp: 'The newest read reflects the final parser state.',
  })

  builder.toolCycle({
    key: 'frontier-verification-pass',
    description: 'Newest verification output after the fix passes.',
    toolName: 'bash',
    args: { command: 'bun test parser.spec.ts --bail' },
    resultText: verificationLog(
      'PASS parser.spec.ts',
      '4 parser tests passed; the final frontier confirms the fix and no regressions remain'
    ),
    trackAs: 'frontier',
  })

  builder.assistantText(
    'The latest read and latest verification result now define the active frontier.'
  )

  return builder.build('stale-logs-with-fresh-frontier')
}

export function expectFrontierPreserved(
  messages: AgentMessage[],
  refs: LongRunArtifactRef[]
): void {
  expect(refs.length).toBeGreaterThan(0)

  for (const ref of refs) {
    const text = getTrackedMessageText(messages, ref)
    expect(text).toBe(ref.originalText)
  }
}

export function expectStalePayloadPruned(
  messages: AgentMessage[],
  refs: LongRunArtifactRef[],
  expectation: PrunedPayloadExpectation = {}
): void {
  expect(refs.length).toBeGreaterThan(0)

  for (const ref of refs) {
    const text = getTrackedMessageText(messages, ref)
    expect(text).not.toBe(ref.originalText)
    expect(text.trim().length).toBeGreaterThan(0)
    expectReplacementMatch(text, ref, expectation.replacementMatcher)
  }
}

export function expectTurnOnlyAgingBlindSpot(
  fixture: LongRunFixture,
  turnAges: number[],
  stepAges: number[],
  protectedTurns: number
): void {
  const trackedRefs = [...fixture.stalePayloads, ...fixture.frontier]
  expect(trackedRefs.length).toBeGreaterThan(0)
  expect(fixture.stalePayloads.length).toBeGreaterThan(0)
  expect(fixture.frontier.length).toBeGreaterThan(0)

  for (const ref of trackedRefs) {
    const { index } = resolveTrackedToolResult(fixture.messages, ref)
    expect(turnAges[index]).toBeLessThan(protectedTurns)
    expect(stepAges[index]).toBeGreaterThanOrEqual(0)
  }

  const staleStepAges = fixture.stalePayloads.map(
    (ref) => stepAges[resolveTrackedToolResult(fixture.messages, ref).index]
  )
  const frontierStepAges = fixture.frontier.map(
    (ref) => stepAges[resolveTrackedToolResult(fixture.messages, ref).index]
  )

  expect(Math.max(...staleStepAges)).toBeGreaterThan(
    Math.min(...frontierStepAges)
  )
}

export function resolveTrackedToolResult(
  messages: AgentMessage[],
  ref: LongRunArtifactRef
): ResolvedToolResult {
  const matches: ResolvedToolResult[] = []

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index] as any
    if (
      message?.role === 'toolResult' &&
      message.toolCallId === ref.toolCallId &&
      message.toolName === ref.toolName
    ) {
      matches.push({ index, message })
    }
  }

  if (matches.length === 1) {
    return matches[0]
  }

  if (matches.length > 1) {
    const indexedMatch = matches.find(
      (match) => match.index === ref.messageIndex
    )
    expect(indexedMatch).toBeDefined()
    return indexedMatch as ResolvedToolResult
  }

  const fallback = messages[ref.messageIndex] as any
  expect(fallback?.role).toBe('toolResult')
  expect(fallback?.toolCallId).toBe(ref.toolCallId)
  expect(fallback?.toolName).toBe(ref.toolName)
  return {
    index: ref.messageIndex,
    message: fallback,
  }
}

function getTrackedMessageText(
  messages: AgentMessage[],
  ref: LongRunArtifactRef
): string {
  const { message } = resolveTrackedToolResult(messages, ref)

  const text = (message.content ?? [])
    .filter((block: any) => block.type === 'text')
    .map((block: any) => block.text)
    .join('')

  expect(typeof text).toBe('string')
  return text
}

function expectReplacementMatch(
  text: string,
  ref: LongRunArtifactRef,
  matcher: PrunedPayloadExpectation['replacementMatcher']
): void {
  if (!matcher) return

  if (typeof matcher === 'string') {
    expect(text).toContain(matcher)
    return
  }

  if (matcher instanceof RegExp) {
    expect(text).toMatch(matcher)
    return
  }

  matcher(text, ref)
}

function parserSnapshot(title: string, branchLine: string): string {
  return [
    `// ${title}`,
    'export function parseTag(input: string) {',
    '  const stack: string[] = []',
    '  for (const token of scan(input)) {',
    `    ${branchLine}`,
    '    stack.push(token.value)',
    '  }',
    '  return stack.join(":")',
    '}',
  ].join('\n')
}

function progressReporterSnapshot(
  title: string,
  highlightedLine: string
): string {
  return [
    `// ${title}`,
    'export function renderProgress(section: string) {',
    '  const headingStyle = "double-line"',
    `  ${highlightedLine}`,
    '  const body = collectProgressLines(section)',
    '  return [headingStyle, body].join("\\n")',
    '}',
  ].join('\n')
}

function verificationLog(status: string, summary: string): string {
  return [
    status,
    `summary: ${summary}`,
    'failing case: escaped close tags should stay inside the current buffered branch',
    'at src/parser.ts:47:13',
    'at src/parser.spec.ts:22:5',
    'hint: rerun with --bail --update-snapshots=false to keep the output deterministic',
  ].join('\n')
}
