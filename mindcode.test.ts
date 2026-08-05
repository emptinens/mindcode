import { describe, expect, test } from 'bun:test'

describe('MindCode Vexzy launcher credential validation', () => {
  test.each(['', 'not-a-forge-key', 'forge-', 'forge-key with-space'])(
    'rejects %j without printing the credential',
    value => {
      const result = Bun.spawnSync({
        cmd: ['zsh', new URL('./mindcode.sh', import.meta.url).pathname],
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

  test('uses the MindCode environment namespace', async () => {
    const launcher = await Bun.file(new URL('./mindcode.sh', import.meta.url)).text()

    expect(launcher).not.toContain('CLAUDE_CODE_')
    expect(launcher).not.toContain('CLAUDE_AUTOCOMPACT_')
    expect(launcher).toContain('mindcode-darwin-arm64')
    expect(launcher).toContain('mindcode-darwin-x64')
    expect(launcher).toContain('mindcode-linux-arm64')
    expect(launcher).toContain('mindcode-linux-x64')
  })
})
