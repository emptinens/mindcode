import { describe, expect, test } from 'bun:test'

describe('claude-vexzy launcher credential validation', () => {
  test.each(['', 'not-a-forge-key', 'forge-', 'forge-key with-space'])(
    'rejects %j without printing the credential',
    value => {
      const result = Bun.spawnSync({
        cmd: ['zsh', new URL('./claude-vexzy.sh', import.meta.url).pathname],
        env: { ...process.env, VEXZY_API_KEY: value },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const stdout = result.stdout.toString()
      const stderr = result.stderr.toString()

      expect(result.exitCode).not.toBe(0)
      expect(stderr).toBe('VEXZY_API_KEY must start with forge-\n')
      expect(stdout).toBe('')
    },
  )
})
