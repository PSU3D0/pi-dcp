#!/usr/bin/env bun
import { resolve } from 'node:path'
import {
  formatReplaySummary,
  replaySession,
  writeTransformedMessages,
  type ReplayOutputFormat,
  type ReplayRequest,
} from '../session-replay'

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!args.sessionPath) {
    printUsage('Missing required --session path')
    process.exit(1)
  }

  const summary = replaySession(args)
  const output = formatReplaySummary(summary, args.output ?? 'markdown')
  process.stdout.write(`${output}\n`)

  if (args.writeTransformedPath) {
    writeTransformedMessages(summary, resolve(args.writeTransformedPath))
  }
}

function parseArgs(argv: string[]): ReplayRequest & {
  output?: ReplayOutputFormat
  writeTransformedPath?: string
} {
  const request: ReplayRequest & {
    output?: ReplayOutputFormat
    writeTransformedPath?: string
  } = {
    sessionPath: '',
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = argv[index + 1]

    switch (arg) {
      case '--session':
        request.sessionPath = requireValue(arg, next)
        index++
        break
      case '--cwd':
        request.cwd = requireValue(arg, next)
        index++
        break
      case '--config':
        request.configPath = requireValue(arg, next)
        index++
        break
      case '--head-line':
        request.headLine = Number.parseInt(requireValue(arg, next), 10)
        index++
        break
      case '--head-message-id':
        request.headMessageId = requireValue(arg, next)
        index++
        break
      case '--subagent-line':
        request.subagentLine = Number.parseInt(requireValue(arg, next), 10)
        index++
        break
      case '--subagent-result-index':
        request.subagentResultIndex = Number.parseInt(
          requireValue(arg, next),
          10
        )
        index++
        break
      case '--pressure':
        request.pressure = {
          ...request.pressure,
          band: requireValue(arg, next) as
            | 'unknown'
            | 'low'
            | 'medium'
            | 'high'
            | 'critical',
        }
        index++
        break
      case '--tokens':
        request.pressure = {
          ...request.pressure,
          tokens: Number.parseInt(requireValue(arg, next), 10),
        }
        index++
        break
      case '--context-window':
        request.pressure = {
          ...request.pressure,
          contextWindow: Number.parseInt(requireValue(arg, next), 10),
        }
        index++
        break
      case '--output':
        request.output = requireValue(arg, next) as ReplayOutputFormat
        index++
        break
      case '--write-transformed':
        request.writeTransformedPath = requireValue(arg, next)
        index++
        break
      case '--help':
      case '-h':
        printUsage()
        process.exit(0)
      default:
        printUsage(`Unknown argument: ${arg}`)
        process.exit(1)
    }
  }

  return request
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`)
  }
  return value
}

function printUsage(error?: string) {
  if (error) {
    console.error(error)
    console.error('')
  }

  console.error(`Usage:
  bun run scripts/replay-session.ts --session <session.jsonl> [options]

Options:
  --cwd <path>                    Working directory used for config/path resolution
  --config <path>                 Explicit dcp.json/jsonc override
  --head-line <n>                 Replay a normal session up to JSONL line n
  --head-message-id <id>          Replay a normal session up to a specific message entry id
  --subagent-line <n>             Replay embedded subagent messages from JSONL line n
  --subagent-result-index <n>     Pick a specific result from a subagent tool result (default: 0)
  --pressure <unknown|low|medium|high|critical>
                                  Simulate a pressure band when runtime usage is unavailable
  --tokens <n>                    Explicit context token count for replay
  --context-window <n>            Explicit context window for replay
  --output <markdown|json>        Output format (default: markdown)
  --write-transformed <path>      Write transformed AgentMessage[] JSON to a file

Examples:
  bun run scripts/replay-session.ts --session ~/.pi/agent/sessions/foo.jsonl --head-line 1200
  bun run scripts/replay-session.ts --session ~/.pi/agent/sessions/foo.jsonl --subagent-line 2108 --pressure low
  bun run scripts/replay-session.ts --session ~/.pi/agent/sessions/foo.jsonl --head-line 900 --tokens 180000 --context-window 272000 --output json
`)
}

main()
