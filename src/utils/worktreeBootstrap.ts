import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { errorMessage } from './errors.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { resolveGitDir } from './git/gitFilesystem.js'
import { findCanonicalGitRoot, gitExe } from './git.js'
import { sleep } from './sleep.js'

const BOOTSTRAP_LOCK_TIMEOUT_MS = 120_000
const BOOTSTRAP_LOCK_STALE_MS = 120_000
const BOOTSTRAP_LOCK_RETRY_MS = 25

const LOCAL_BOOTSTRAP_EXCLUDES = [
  '# MindCode agent bootstrap: local-only snapshot exclusions',
  '/.mindcode/',
  'node_modules/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.turbo/',
  '.cache/',
  'coverage/',
  'target/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.pytest_cache/',
  '.DS_Store',
  '.env',
  '.env.*',
  '!.env.example',
  '**/credentials',
  '**/credentials.*',
  '**/credentials/**',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
]

function bootstrapLockPath(projectRoot: string): string {
  return join(projectRoot, '.mindcode', '.git-bootstrap.lock')
}

async function staleBootstrapLock(lockPath: string): Promise<boolean> {
  try {
    const owner = (await readFile(join(lockPath, 'owner'), 'utf8')).trim()
    const pid = Number(owner)
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0)
        return false
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          return false
        }
        return true
      }
    }

    const lockStat = await stat(lockPath)
    return Date.now() - lockStat.mtimeMs > BOOTSTRAP_LOCK_STALE_MS
  } catch {
    return false
  }
}

/** Serialize repository initialization and worktree creation atomically. */
export async function withBootstrapLock<T>(
  projectRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = bootstrapLockPath(projectRoot)
  await mkdir(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + BOOTSTRAP_LOCK_TIMEOUT_MS

  while (true) {
    try {
      await mkdir(lockPath)
      await writeFile(join(lockPath, 'owner'), `${process.pid}\n`, 'utf8')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error(
          `Cannot acquire local Git bootstrap lock at ${lockPath}: ${errorMessage(error)}`,
        )
      }
      if (await staleBootstrapLock(lockPath)) {
        await rm(lockPath, { recursive: true, force: true })
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for local Git bootstrap lock at ${lockPath}. Retry the agent spawn after the other bootstrap finishes.`,
        )
      }
      await sleep(BOOTSTRAP_LOCK_RETRY_MS)
    }
  }

  try {
    return await operation()
  } finally {
    await rm(lockPath, { recursive: true, force: true })
  }
}

async function hasValidHead(repoRoot: string): Promise<boolean> {
  const { code } = await execFileNoThrowWithCwd(
    gitExe(),
    ['rev-parse', '--verify', '--quiet', 'HEAD'],
    { cwd: repoRoot, preserveOutputOnError: false },
  )
  return code === 0
}

async function appendLocalBootstrapExcludes(repoRoot: string): Promise<void> {
  // Prefer the direct path after `git init`. The Git-root finder is memoized,
  // so a pre-init miss can remain cached in the same process.
  let gitDir: string | null = null
  try {
    const directGitPath = join(repoRoot, '.git')
    const directStat = await stat(directGitPath)
    if (directStat.isDirectory()) {
      gitDir = directGitPath
    } else if (directStat.isFile()) {
      const content = (await readFile(directGitPath, 'utf8')).trim()
      if (content.startsWith('gitdir:')) {
        gitDir = resolve(repoRoot, content.slice('gitdir:'.length).trim())
      }
    }
  } catch {
    // Fall back to the normal resolver for unusual repository layouts.
  }
  gitDir ??= await resolveGitDir(repoRoot)
  if (!gitDir) {
    throw new Error(`Cannot determine the local Git directory for ${repoRoot}`)
  }

  const excludePath = join(gitDir, 'info', 'exclude')
  await mkdir(dirname(excludePath), { recursive: true })
  let existing = ''
  try {
    existing = await readFile(excludePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const existingLines = existing.split(/\r?\n/)
  const missing = LOCAL_BOOTSTRAP_EXCLUDES.filter(
    pattern => !existingLines.includes(pattern),
  )
  if (missing.length === 0) return
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n` : existing
  await writeFile(excludePath, `${prefix}${missing.join('\n')}\n`, 'utf8')
}

async function ensureLocalIdentity(repoRoot: string): Promise<void> {
  const identity = [
    ['user.name', 'MindCode'],
    ['user.email', 'mindcode@local.invalid'],
  ] as const
  for (const [key, fallback] of identity) {
    const current = await execFileNoThrowWithCwd(
      gitExe(),
      ['config', '--local', '--get', key],
      { cwd: repoRoot, preserveOutputOnError: false },
    )
    if (current.code !== 0 || !current.stdout.trim()) {
      const configured = await execFileNoThrowWithCwd(
        gitExe(),
        ['config', '--local', key, fallback],
        { cwd: repoRoot },
      )
      if (configured.code !== 0) {
        throw new Error(
          `Cannot configure repository-local Git identity ${key}: ${configured.stderr.trim() || 'git config failed'}`,
        )
      }
    }
  }
}

async function createInitialLocalSnapshot(repoRoot: string): Promise<void> {
  if (await hasValidHead(repoRoot)) return

  await appendLocalBootstrapExcludes(repoRoot)
  await ensureLocalIdentity(repoRoot)

  const add = await execFileNoThrowWithCwd(gitExe(), ['add', '-A'], {
    cwd: repoRoot,
  })
  if (add.code !== 0) {
    throw new Error(
      `Cannot stage the local Git snapshot in ${repoRoot}: ${add.stderr.trim() || 'git add failed'}`,
    )
  }

  const commit = await execFileNoThrowWithCwd(
    gitExe(),
    [
      'commit',
      '--no-verify',
      '--allow-empty',
      '-m',
      'chore: initialize local MindCode snapshot',
    ],
    { cwd: repoRoot },
  )
  if (commit.code !== 0 || !(await hasValidHead(repoRoot))) {
    throw new Error(
      `Cannot create the local Git snapshot in ${repoRoot}: ${commit.stderr.trim() || 'git commit failed'}`,
    )
  }
}

export async function ensureLocalGitRepositoryUnlocked(
  requestedRoot: string,
): Promise<string> {
  let gitRoot = findCanonicalGitRoot(requestedRoot)
  if (!gitRoot) {
    const init = await execFileNoThrowWithCwd(gitExe(), ['init'], {
      cwd: requestedRoot,
    })
    if (init.code !== 0) {
      throw new Error(
        `Cannot initialize a local Git repository in ${requestedRoot}: ${init.stderr.trim() || 'git init failed'}`,
      )
    }
    gitRoot = requestedRoot
  }

  await createInitialLocalSnapshot(gitRoot)
  return gitRoot
}

/**
 * Ensure a local repository with a valid HEAD for an agent worktree. Existing
 * repositories with commits are left untouched; no remote operation occurs.
 */
export async function bootstrapLocalGitRepository(
  projectRoot: string,
): Promise<string> {
  const requestedRoot = resolve(projectRoot)
  return withBootstrapLock(requestedRoot, () =>
    ensureLocalGitRepositoryUnlocked(requestedRoot),
  )
}
