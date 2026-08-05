import { describe, expect, test } from 'bun:test'
import { subprocessEnv } from './subprocessEnv.js'

describe('Vexzy subprocess environment wiring', () => {
  test('preserves VEXZY_API_KEY when subprocess scrubbing is enabled', () => {
    const previousKey = process.env.VEXZY_API_KEY
    const previousScrub = process.env.MINDCODE_SUBPROCESS_ENV_SCRUB

    process.env.VEXZY_API_KEY = 'forge-worker-key'
    process.env.MINDCODE_SUBPROCESS_ENV_SCRUB = '1'

    try {
      expect(subprocessEnv().VEXZY_API_KEY).toBe('forge-worker-key')
    } finally {
      if (previousKey === undefined) {
        Reflect.deleteProperty(process.env, 'VEXZY_API_KEY')
      } else {
        process.env.VEXZY_API_KEY = previousKey
      }
      if (previousScrub === undefined) {
        Reflect.deleteProperty(
          process.env,
          'MINDCODE_SUBPROCESS_ENV_SCRUB',
        )
      } else {
        process.env.MINDCODE_SUBPROCESS_ENV_SCRUB = previousScrub
      }
    }
  })
})
