import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { DCPConfig } from './types'

const DEFAULT_CONFIG: DCPConfig = {
  enabled: true,
  mode: 'safe',
  debug: false,
  turnProtection: { enabled: true, turns: 8 },
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

export function loadConfig(cwd: string): DCPConfig {
  let config = { ...DEFAULT_CONFIG }

  const globalPath = join(homedir(), '.pi', 'agent', 'dcp.json')
  if (existsSync(globalPath)) {
    try {
      const globalConfig = JSON.parse(readFileSync(globalPath, 'utf-8'))
      config = mergeDeep(config, globalConfig)
    } catch (e) {
      console.error('[DCP] Failed to load global config:', e)
    }
  }

  const localPath = join(cwd, '.pi', 'dcp.json')
  if (existsSync(localPath)) {
    try {
      const localConfig = JSON.parse(readFileSync(localPath, 'utf-8'))
      config = mergeDeep(config, localConfig)
    } catch (e) {
      console.error('[DCP] Failed to load local config:', e)
    }
  }

  return config
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
