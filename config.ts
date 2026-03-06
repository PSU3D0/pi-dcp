import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DCPConfig } from './types'

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? U[]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K]
}

const DEFAULT_CONFIG: DCPConfig = {
  enabled: true,
  mode: 'safe',
  debug: false,
  turnProtection: { enabled: true, turns: 8 },
  stepProtection: { enabled: true, steps: 2 },
  thresholds: {
    nudge: 0.7,
    autoPrune: 0.8,
    forceCompact: 0.9,
  },
  protectedTools: [
    'todo',
    'subagent',
    'send_to_session',
    'plan_enter',
    'plan_exit',
  ],
  protectedFilePatterns: ['**/CHANGELOG.md', '**/*.plan.md', '**/progress.md'],
  strategies: {
    deduplicate: { enabled: true },
    purgeErrors: { enabled: true, minTurnAge: 3 },
    outputBodyReplace: { enabled: true, minChars: 1200 },
    supersedeWrites: { enabled: false },
  },
  advanced: {
    distillTool: { enabled: false },
    compressTool: { enabled: false },
    llmAutonomy: false,
  },
}

export function getDefaultConfig(): DCPConfig {
  return structuredClone(DEFAULT_CONFIG)
}

export function mergeConfig(
  ...overrides: Array<DeepPartial<DCPConfig> | undefined>
): DCPConfig {
  const config = getDefaultConfig()

  for (const override of overrides) {
    if (override) {
      mergeDeep(config, override)
    }
  }

  return config
}

export function getConfigSearchPaths(
  cwd: string,
  homeDir = homedir()
): string[] {
  const globalDir = join(homeDir, '.pi', 'agent')
  const localDir = join(cwd, '.pi')

  return [
    join(globalDir, 'dcp.json'),
    join(globalDir, 'dcp.jsonc'),
    join(localDir, 'dcp.json'),
    join(localDir, 'dcp.jsonc'),
  ]
}

export function parseConfigText(text: string): DeepPartial<DCPConfig> {
  const withoutBom = text.replace(/^\uFEFF/, '')
  const withoutComments = stripJsonComments(withoutBom)
  const withoutTrailingCommas = withoutComments.replace(/,\s*([}\]])/g, '$1')
  return JSON.parse(withoutTrailingCommas)
}

export function loadConfig(cwd: string, homeDir = homedir()): DCPConfig {
  const overrides: Array<DeepPartial<DCPConfig>> = []

  for (const path of getConfigSearchPaths(cwd, homeDir)) {
    const override = readConfigOverride(path)
    if (override) {
      overrides.push(override)
    }
  }

  return mergeConfig(...overrides)
}

function readConfigOverride(path: string): DeepPartial<DCPConfig> | undefined {
  if (!existsSync(path)) {
    return undefined
  }

  try {
    return parseConfigText(readFileSync(path, 'utf-8'))
  } catch (error) {
    console.error(`[DCP] Failed to load config from ${path}:`, error)
    return undefined
  }
}

function stripJsonComments(input: string): string {
  let output = ''
  let inString = false
  let stringDelimiter = '"'
  let escaping = false
  let inLineComment = false
  let inBlockComment = false

  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    const next = input[index + 1]

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false
        output += char
      }
      continue
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        index++
      }
      continue
    }

    if (inString) {
      output += char

      if (escaping) {
        escaping = false
        continue
      }

      if (char === '\\') {
        escaping = true
        continue
      }

      if (char === stringDelimiter) {
        inString = false
      }

      continue
    }

    if ((char === '"' || char === "'") && !inString) {
      inString = true
      stringDelimiter = char
      output += char
      continue
    }

    if (char === '/' && next === '/') {
      inLineComment = true
      index++
      continue
    }

    if (char === '/' && next === '*') {
      inBlockComment = true
      index++
      continue
    }

    output += char
  }

  return output
}

function mergeDeep(target: any, source: any): any {
  if (isObject(target) && isObject(source)) {
    for (const key in source) {
      if (isObject(source[key])) {
        if (!target[key]) Object.assign(target, { [key]: {} })
        mergeDeep(target[key], source[key])
      } else {
        Object.assign(target, { [key]: source[key] })
      }
    }
  }
  return target
}

function isObject(item: any) {
  return item && typeof item === 'object' && !Array.isArray(item)
}
