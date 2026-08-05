import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrapLocalGitRepository } from './worktreeBootstrap.js'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mindcode-worktree-bootstrap-'))
  temporaryRoots.push(root)
  return root
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function initializeGit(root: string): void {
  git(root, ['init'])
  git(root, ['config', 'user.name', 'Existing User'])
  git(root, ['config', 'user.email', 'existing@local.invalid'])
}

describe('local agent worktree bootstrap', () => {
  test('initializes a non-repository and creates a valid local snapshot', async () => {
    const root = temporaryRoot()
    writeFileSync(join(root, 'src.ts'), 'export const source = true\n')

    const gitRoot = await bootstrapLocalGitRepository(root)

    expect(gitRoot).toBe(root)
    expect(git(root, ['rev-parse', '--verify', 'HEAD'])).toMatch(/^[0-9a-f]{40}$/)
    expect(git(root, ['ls-files'])).toContain('src.ts')
    expect(git(root, ['remote'])).toBe('')
    expect(git(root, ['config', '--local', 'user.name'])).toBe('MindCode')
    expect(git(root, ['config', '--local', 'user.email'])).toBe(
      'mindcode@local.invalid',
    )
  })

  test('snapshots source files while excluding caches and secrets', async () => {
    const root = temporaryRoot()
    initializeGit(root)
    writeFileSync(join(root, 'main.ts'), 'export const main = true\n')
    writeFileSync(join(root, '.env'), 'VEXZY_API_KEY=forge-secret\n')
    writeFileSync(join(root, 'credentials.json'), '{"token":"secret"}\n')
    writeFileSync(join(root, 'private.pem'), 'PRIVATE KEY\n')
    writeFileSync(join(root, 'node_modules.txt'), 'source-like file\n')
    mkdirSync(join(root, 'node_modules'))
    await Bun.write(join(root, 'node_modules', 'ignored.js'), 'cache')

    await bootstrapLocalGitRepository(root)

    const files = git(root, ['ls-files']).split('\n').filter(Boolean)
    expect(files).toContain('main.ts')
    expect(files).not.toContain('.env')
    expect(files).not.toContain('credentials.json')
    expect(files).not.toContain('private.pem')
    expect(files).not.toContain('node_modules/ignored.js')
  })

  test('creates a worktree with committed source files', async () => {
    const root = temporaryRoot()
    writeFileSync(join(root, 'visible.ts'), 'export const visible = 1\n')
    await bootstrapLocalGitRepository(root)
    const worktreePath = join(root, '.mindcode', 'worktrees', 'bootstrap-visible')

    git(root, ['worktree', 'add', '-b', 'worktree-bootstrap-visible', worktreePath, 'HEAD'])
    try {
      expect(git(worktreePath, ['show', '--format=%H', '--no-patch'])).toMatch(
        /^[0-9a-f]{40}$/,
      )
      expect(git(worktreePath, ['ls-files'])).toContain('visible.ts')
    } finally {
      git(root, ['worktree', 'remove', '--force', worktreePath])
      git(root, ['branch', '-D', 'worktree-bootstrap-visible'])
    }
  })

  test('concurrent bootstrap produces exactly one valid initial HEAD', async () => {
    const root = temporaryRoot()
    writeFileSync(join(root, 'source.ts'), 'export const source = 1\n')

    await Promise.all(
      Array.from({ length: 8 }, () => bootstrapLocalGitRepository(root)),
    )

    expect(git(root, ['rev-list', '--count', 'HEAD'])).toBe('1')
    expect(git(root, ['remote'])).toBe('')
  }, 15_000)

  test('does not commit or alter an existing dirty repository', async () => {
    const root = temporaryRoot()
    initializeGit(root)
    writeFileSync(join(root, 'tracked.ts'), 'const before = 1\n')
    git(root, ['add', 'tracked.ts'])
    git(root, ['commit', '-m', 'existing'])
    const headBefore = git(root, ['rev-parse', 'HEAD'])
    writeFileSync(join(root, 'tracked.ts'), 'const after = 2\n')
    writeFileSync(join(root, 'untracked.ts'), 'const untracked = true\n')
    const statusBefore = git(root, ['status', '--porcelain'])

    await bootstrapLocalGitRepository(root)
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(headBefore)
    expect(git(root, ['status', '--porcelain'])).toBe(statusBefore)
    expect(git(root, ['rev-list', '--count', 'HEAD'])).toBe('1')
    expect(git(root, ['remote'])).toBe('')
  })
})
