#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const cachePath = resolve(root, '.mindcode-cache', 'bun-transpiler')
const result = spawnSync(
  process.env.BUN_BINARY || 'bun',
  ['test', ...process.argv.slice(2)],
  {
    cwd: root,
    env: {
      ...process.env,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: cachePath,
    },
    stdio: 'inherit',
  },
)

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}

if (result.signal) {
  console.error(`bun test terminated by ${result.signal}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
