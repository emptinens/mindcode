import { describe, expect, test } from 'bun:test'

const launcherUrl = new URL('./mindcode.sh', import.meta.url)
const launcherPath = launcherUrl.pathname
const launcherSource = await Bun.file(launcherUrl).text()

function hostTarget(): string {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'mindcode-darwin-arm64' : 'mindcode-darwin-x64'
  }
  if (process.platform === 'linux') {
    return process.arch === 'arm64' ? 'mindcode-linux-arm64' : 'mindcode-linux-x64'
  }
  return 'mindcode.exe'
}

type Fixture = {
  root: string
  cwd: string
  log: string
  curlLog: string
  env: Record<string, string>
}

async function fixture(): Promise<Fixture> {
  const root = (await Bun.$`mktemp -d`.text()).trim()
  const cwd = `${root}/cwd`
  const bin = `${root}/bin`
  const dist = `${root}/dist`
  const log = `${root}/binary.log`
  const curlLog = `${root}/curl.log`
  await Bun.$`mkdir -p ${cwd} ${bin} ${dist}`
  await Bun.write(`${root}/mindcode.sh`, launcherSource)
  await Bun.write(
    `${dist}/${hostTarget()}`,
    `#!/bin/sh
{
  printf 'cwd=%s\\n' "$PWD"
  printf 'args='
  for arg in "$@"; do printf '[%s]' "$arg"; done
  printf '\\n'
  printf 'worker=%s\\n' "${'$'}{MINDCODE_SUBAGENT_MODEL:-missing}"
  printf 'compact=%s\\n' "${'$'}{MINDCODE_COMPACT_MODEL:-missing}"
  printf 'teams=%s\\n' "${'$'}{MINDCODE_EXPERIMENTAL_AGENT_TEAMS:-missing}"
  printf 'delegation=%s\\n' "${'$'}{MINDCODE_DELEGATION_FIRST:-missing}"
  printf 'compact_threshold=%s\\n' "${'$'}{MINDCODE_AUTOCOMPACT_PCT_OVERRIDE:-missing}"
  printf 'anthropic=%s\\n' "${'$'}{ANTHROPIC_BASE_URL:-missing}"
  printf 'claude=%s\\n' "${'$'}{CLAUDE_CODE_USE_BEDROCK:-missing}"
} > "${'$'}{FAKE_BINARY_LOG:?}"
`,
  )
  await Bun.$`chmod +x ${root}/mindcode.sh ${dist}/${hostTarget()}`
  const realCwd = Bun.spawnSync({ cmd: ['pwd', '-P'], cwd }).stdout.toString().trim()
  return {
    root,
    cwd: realCwd,
    log,
    curlLog,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_BINARY_LOG: log,
      CURL_LOG: curlLog,
      VEXZY_API_KEY: 'forge-test-key',
    },
  }
}

async function installCurl(f: Fixture, response: string, exitCode = 0): Promise<void> {
  await Bun.write(
    `${f.root}/bin/curl`,
    `#!/bin/sh
config=$(cat)
case "$config" in
  *'Authorization: Bearer forge-'*) printf 'auth=yes\\n' > "$CURL_LOG" ;;
  *) printf 'auth=no\\n' > "$CURL_LOG" ;;
esac
${exitCode === 0 ? `printf '%s\\n' '${response}'` : `exit ${exitCode}`}
`,
  )
  await Bun.$`chmod +x ${f.root}/bin/curl`
}

function run(f: Fixture, args: string[], env = f.env) {
  return Bun.spawnSync({
    cmd: ['zsh', `${f.root}/mindcode.sh`, ...args],
    cwd: f.cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

async function runInteractive(f: Fixture, args: string[], input: string) {
  const child = Bun.spawn({
    cmd: ['zsh', `${f.root}/mindcode.sh`, ...args],
    cwd: f.cwd,
    env: f.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  child.stdin.write(input)
  child.stdin.end()
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe('mindcode.sh', () => {
  test.each(['', 'not-a-forge-key', 'forge-', 'forge-key with-space', 'forge-key\nquoted'])(
    'rejects invalid VEXZY_API_KEY %j without printing it',
    value => {
      const result = Bun.spawnSync({
        cmd: ['zsh', launcherPath],
        env: { ...process.env, VEXZY_API_KEY: value },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const stdout = result.stdout.toString()
      const stderr = result.stderr.toString()

      expect(result.exitCode).not.toBe(0)
      expect(stderr).toBe('VEXZY_API_KEY must start with forge-\n')
      expect(stdout).toBe('')
      if (value !== '' && value !== 'forge-') {
        expect(stderr).not.toContain(value)
      }
    },
  )

  test('has only MindCode exports, fixed workers, adaptive teams, and a fixed 95% threshold', () => {
    expect(launcherSource).not.toMatch(/\bexport\s+(?:ANTHROPIC|CLAUDE)_/)
    expect(launcherSource).not.toContain('claude-code')
    expect(launcherSource).toContain('export MINDCODE_EXPERIMENTAL_AGENT_TEAMS="1"')
    expect(launcherSource).toContain('export MINDCODE_DELEGATION_FIRST="1"')
    expect(launcherSource).toContain('export MINDCODE_SUBAGENT_MODEL="gpt-5.6-luna"')
    expect(launcherSource).toContain('export MINDCODE_COMPACT_MODEL="gpt-5.6-luna"')
    expect(launcherSource).toContain('export MINDCODE_AUTOCOMPACT_PCT_OVERRIDE="95"')
    expect(launcherSource).not.toContain('MINDCODE_MAX_WORKERS')
    expect(launcherSource).not.toContain('ANTHROPIC_BASE_URL=')
    expect(launcherSource).not.toContain('CLAUDE_CODE_')
    expect(launcherSource).toContain('mindcode-darwin-arm64')
    expect(launcherSource).toContain('mindcode-darwin-x64')
    expect(launcherSource).toContain('mindcode-linux-arm64')
    expect(launcherSource).toContain('mindcode-linux-x64')
    expect(launcherSource).toContain('mindcode.exe')
  })

  test('does not fetch models without --menu and preserves cwd and arbitrary args', async () => {
    const f = await fixture()
    const result = run(f, ['--model', 'leader-id', '--effort', 'xhigh', '--custom', 'two words'])
    const log = await Bun.file(f.log).text()

    expect(result.exitCode).toBe(0)
    expect(log).toContain(`cwd=${f.cwd}\n`)
    expect(log).toContain('args=[--model][leader-id][--effort][xhigh][--custom][two words]')
    expect(log).toContain('worker=gpt-5.6-luna')
    expect(log).toContain('compact=gpt-5.6-luna')
    expect(log).toContain('teams=1')
    expect(log).toContain('delegation=1')
    expect(log).toContain('compact_threshold=95')
    expect(await Bun.file(f.curlLog).exists()).toBe(false)
    expect(result.stdout.toString()).not.toContain('forge-test-key')
    expect(result.stderr.toString()).not.toContain('forge-test-key')
  })

  test('removes legacy provider environment and ignores an inherited threshold override', async () => {
    const f = await fixture()
    const result = run(f, [], {
      ...f.env,
      ANTHROPIC_BASE_URL: 'https://legacy.invalid',
      CLAUDE_CODE_USE_BEDROCK: '1',
      MINDCODE_AUTOCOMPACT_PCT_OVERRIDE: '40',
      MINDCODE_USE_BEDROCK: '1',
    })
    const log = await Bun.file(f.log).text()

    expect(result.exitCode).toBe(0)
    expect(log).toContain('anthropic=missing')
    expect(log).toContain('claude=missing')
    expect(log).toContain('compact_threshold=95')
  })

  test('forwards every supported effort and rejects unsupported thinking', async () => {
    for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
      const f = await fixture()
      const result = run(f, ['--effort', effort])
      expect(result.exitCode).toBe(0)
      expect(await Bun.file(f.log).text()).toContain(`args=[--effort][${effort}]`)
    }

    const f = await fixture()
    const result = run(f, ['--thinking', 'enabled'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr.toString()).toContain('Use --effort')
    expect(await Bun.file(f.log).exists()).toBe(false)

    const duplicateFixture = await fixture()
    const duplicate = run(duplicateFixture, ['--effort', 'low', '--effort=max'])
    expect(duplicate.exitCode).toBe(2)
    expect(duplicate.stderr.toString()).toContain('Duplicate --effort is not allowed')
    expect(await Bun.file(duplicateFixture.log).exists()).toBe(false)
  })

  test('uses exact model effort values and order from the registry in --menu', async () => {
    const f = await fixture()
    await installCurl(
      f,
      JSON.stringify({
        data: [
          {
            id: 'registry-leader',
            display_name: 'Registry Leader',
            owned_by: 'vexzy',
            context_length: 1050000,
            supported_reasoning_efforts: ['auto', 'minimal', 'none'],
            available: true,
          },
          { id: 'not-available', available: false },
        ],
      }),
    )
    const result = await runInteractive(
      f,
      ['--menu', '--passthrough', 'x', '--', '--literal'],
      '1\n2\n',
    )
    const log = await Bun.file(f.log).text()

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('registry-leader')
    expect(result.stdout).toContain('name=Registry Leader')
    expect(result.stdout).toContain('context=1050000')
    expect(result.stdout).not.toContain('not-available')
    expect(result.stdout).toContain('Leader effort for registry-leader:')
    expect(result.stdout).toContain('1) auto\n2) minimal\n3) none')
    expect(log).toContain(
      'args=[--passthrough][x][--model][registry-leader][--effort][minimal][--][--literal]',
    )
    expect(await Bun.file(f.curlLog).text()).toBe('auth=yes\n')
    expect(`${result.stdout}${result.stderr}`).not.toContain('forge-test-key')
  })

  test('prompts for the matching model effort when --model is already set', async () => {
    const f = await fixture()
    await installCurl(
      f,
      JSON.stringify({
        data: [
          { id: 'other-model', supported_reasoning_efforts: ['none'] },
          {
            id: 'selected-model',
            supported_reasoning_efforts: ['max', 'low', 'high'],
            available: true,
          },
        ],
      }),
    )
    const result = await runInteractive(
      f,
      ['--menu', '--model=selected-model', '--custom', 'value'],
      '2\n',
    )
    const log = await Bun.file(f.log).text()

    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain('Select model')
    expect(result.stdout).toContain('Leader effort for selected-model:')
    expect(result.stdout).toContain('1) max\n2) low\n3) high')
    expect(log).toContain('args=[--model=selected-model][--custom][value][--effort][low]')
  })

  test('does not prompt for or duplicate an explicit --effort in --menu', async () => {
    const f = await fixture()
    await installCurl(
      f,
      JSON.stringify({
        data: [
          {
            id: 'selected-model',
            supported_reasoning_efforts: ['none', 'low', 'high'],
            available: true,
          },
        ],
      }),
    )
    const result = await runInteractive(
      f,
      ['--menu', '--model', 'selected-model', '--effort=high'],
      '',
    )
    const log = await Bun.file(f.log).text()

    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain('Select model')
    expect(result.stdout).not.toContain('Select effort')
    expect(log).toContain('args=[--model][selected-model][--effort=high]')
    expect(log.match(/\[--effort(?:=high)?\]/g)).toHaveLength(1)
  })

  test('uses the curated fallback when the bounded registry request fails', async () => {
    const f = await fixture()
    await installCurl(f, '', 28)
    const result = await runInteractive(f, ['--menu'], '2\n6\n')
    const log = await Bun.file(f.log).text()

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('gpt-5.6-luna')
    expect(result.stdout).toContain('gpt-5.6-terra')
    expect(result.stdout).toContain('gpt-5.6-sol')
    expect(result.stdout).toContain('1) none\n2) low\n3) medium\n4) high\n5) xhigh\n6) max')
    expect(log).toContain('args=[--model][gpt-5.6-terra][--effort][max]')
    expect(`${result.stdout}${result.stderr}`).not.toContain('forge-test-key')
  })
})
