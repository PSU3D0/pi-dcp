import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getConfigSearchPaths, loadConfig, parseConfigText } from '../config'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

function makeTempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

test('parseConfigText accepts JSONC comments and trailing commas', () => {
  const parsed = parseConfigText(`
    {
      // Keep DCP on by default.
      "enabled": true,
      "turnProtection": {
        "turns": 6,
      },
      /* Preserve a few active steps. */
      "stepProtection": {
        "enabled": true,
        "steps": 3,
      },
      "protectedFilePatterns": [
        "**/*.plan.md",
      ],
    }
  `)

  expect(parsed.enabled).toBe(true)
  expect(parsed.turnProtection?.turns).toBe(6)
  expect(parsed.stepProtection?.steps).toBe(3)
  expect(parsed.protectedFilePatterns).toEqual(['**/*.plan.md'])
})

test('getConfigSearchPaths prefers jsonc over json within each scope', () => {
  const paths = getConfigSearchPaths('/repo/project', '/home/test-user')

  expect(paths).toEqual([
    '/home/test-user/.pi/agent/dcp.json',
    '/home/test-user/.pi/agent/dcp.jsonc',
    '/repo/project/.pi/dcp.json',
    '/repo/project/.pi/dcp.jsonc',
  ])
})

test('loadConfig merges global and local json/jsonc overrides in search order', () => {
  const homeDir = makeTempRoot('dcp-home-')
  const cwd = makeTempRoot('dcp-project-')
  const globalDir = join(homeDir, '.pi', 'agent')
  const localDir = join(cwd, '.pi')

  mkdirSync(globalDir, { recursive: true })
  mkdirSync(localDir, { recursive: true })

  writeFileSync(
    join(globalDir, 'dcp.json'),
    JSON.stringify({
      turnProtection: { turns: 10 },
      strategies: { outputBodyReplace: { minChars: 1600 } },
    })
  )
  writeFileSync(
    join(globalDir, 'dcp.jsonc'),
    `{
      // JSONC should override the plain global JSON when both exist.
      "turnProtection": { "turns": 9 },
      "stepProtection": { "steps": 3 },
    }`
  )
  writeFileSync(
    join(localDir, 'dcp.json'),
    JSON.stringify({
      protectedFilePatterns: ['**/*.ops.md'],
      thresholds: { autoPrune: 0.82 },
    })
  )
  writeFileSync(
    join(localDir, 'dcp.jsonc'),
    `{
      // Local JSONC wins last.
      "turnProtection": { "turns": 6 },
      "debug": true,
    }`
  )

  const config = loadConfig(cwd, homeDir)

  expect(config.turnProtection.turns).toBe(6)
  expect(config.stepProtection.steps).toBe(3)
  expect(config.strategies.outputBodyReplace.minChars).toBe(1600)
  expect(config.protectedFilePatterns).toEqual(['**/*.ops.md'])
  expect(config.thresholds.autoPrune).toBe(0.82)
  expect(config.debug).toBe(true)
})
