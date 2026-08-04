/**
 * PATH setup for the native installer.
 *
 * checkInstall() only *reports* that the install directory is missing from
 * PATH and leaves the user to fix it by hand (a GUI walkthrough on Windows).
 * This module actually performs the write, per-user, without elevation:
 *
 *   Windows — HKCU\Environment via `reg add`
 *   macOS   — the login shell's rc/profile file
 *   Linux   — the interactive shell's rc file
 *
 * Every write is idempotent: if the directory is already on PATH (however it
 * got there) nothing is written.
 */

import { stat } from 'fs/promises'
import { homedir as osHomedir } from 'os'
import { delimiter, join, resolve } from 'path'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { execFileNoThrow } from '../execFileNoThrow.js'
import { getShellType } from '../localInstaller.js'
import { getShellConfigPaths, readFileLines, writeFileLines } from '../shellConfig.js'
import type { SetupMessage } from './installer.js'

const MARKER = '# Added by Claude Code'

/** Windows user PATH lives here. Machine-wide PATH would need elevation. */
const WINDOWS_ENV_KEY = 'HKCU\\Environment'

/**
 * Compare two filesystem paths for PATH-membership purposes: resolve them,
 * drop trailing separators, and ignore case on Windows.
 */
function pathsEqual(a: string, b: string, isWindows: boolean): boolean {
  const norm = (p: string): string => {
    let out = resolve(p).replace(/[\\/]+$/, '')
    if (isWindows) out = out.toLowerCase()
    return out
  }
  try {
    return norm(a) === norm(b)
  } catch {
    return false
  }
}

/**
 * Expand %VAR% references in a Windows PATH entry. REG_EXPAND_SZ values
 * commonly store entries as %USERPROFILE%\... — without expanding, the
 * membership check misses them and we would append a duplicate.
 */
function expandWindowsVars(entry: string): string {
  return entry.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(process.env).find(
      k => k.toLowerCase() === name.toLowerCase(),
    )
    return key ? (process.env[key] ?? whole) : whole
  })
}

/** Whether `dir` already appears in a `delimiter`-joined PATH string. */
function pathContainsDir(
  pathValue: string,
  dir: string,
  isWindows: boolean,
): boolean {
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .some(entry =>
      pathsEqual(isWindows ? expandWindowsVars(entry) : entry, dir, isWindows),
    )
}

type WindowsPathValue = {
  /** Existing value, or '' when the Path entry does not exist yet. */
  value: string
  /** REG_EXPAND_SZ must be preserved or %VAR% entries freeze into literals. */
  type: 'REG_SZ' | 'REG_EXPAND_SZ'
}

/**
 * Read the persisted per-user PATH from the registry.
 *
 * `reg query` output looks like:
 *     HKEY_CURRENT_USER\Environment
 *         Path    REG_EXPAND_SZ    C:\foo;C:\bar
 *
 * A missing Path entry is normal on fresh profiles and is reported as an
 * empty REG_EXPAND_SZ rather than an error.
 */
async function readWindowsUserPath(): Promise<WindowsPathValue | null> {
  const { stdout, code } = await execFileNoThrow(
    'reg',
    ['query', WINDOWS_ENV_KEY, '/v', 'Path'],
    { useCwd: false },
  )
  if (code !== 0) {
    // No user-level Path value yet — we will create it.
    return { value: '', type: 'REG_EXPAND_SZ' }
  }
  // Value data may itself contain whitespace, so split on the type token
  // instead of tokenizing the whole line.
  const match = stdout.match(/^\s*Path\s+(REG_EXPAND_SZ|REG_SZ)\s+(.*)$/im)
  if (!match?.[1]) {
    return null
  }
  return {
    value: (match[2] ?? '').trim(),
    type: match[1] as WindowsPathValue['type'],
  }
}

/**
 * Prepend `binDir` to the persisted per-user PATH on Windows.
 *
 * Uses `reg add` rather than `setx`: setx silently truncates the value at 1024
 * characters, which would corrupt the PATH of any machine with a normal amount
 * of tooling installed.
 */
async function addToWindowsPath(binDir: string): Promise<SetupMessage[]> {
  const windowsBinPath = binDir.replace(/\//g, '\\')

  const current = await readWindowsUserPath()
  if (!current) {
    return [manualWindowsMessage(windowsBinPath)]
  }

  if (pathContainsDir(current.value, binDir, true)) {
    logForDebugging(`PATH setup: ${windowsBinPath} already in persisted user PATH`)
    return []
  }

  const newValue = current.value
    ? `${windowsBinPath}${delimiter}${current.value}`
    : windowsBinPath

  const { code } = await execFileNoThrow(
    'reg',
    [
      'add',
      WINDOWS_ENV_KEY,
      '/v',
      'Path',
      '/t',
      current.type,
      '/d',
      newValue,
      '/f',
    ],
    { useCwd: false },
  )
  if (code !== 0) {
    // Most likely the assembled value exceeded the command-line length limit.
    // Leave PATH untouched and fall back to manual instructions.
    logForDebugging(`PATH setup: reg add failed with code ${code}`, {
      level: 'error',
    })
    return [manualWindowsMessage(windowsBinPath)]
  }

  logForDebugging(`PATH setup: added ${windowsBinPath} to persisted user PATH`)
  return [
    {
      message: `Added ${windowsBinPath} to your user PATH. Restart your terminal for the claude command to be available.`,
      userActionRequired: false,
      type: 'info',
    },
  ]
}

function manualWindowsMessage(windowsBinPath: string): SetupMessage {
  return {
    message: `Could not update your PATH automatically. Add ${windowsBinPath} manually: System Properties → Environment Variables → Edit User PATH → New → Add the path above. Then restart your terminal.`,
    userActionRequired: true,
    type: 'path',
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Pick the config file to write for the current shell.
 *
 * bash is the awkward case: Terminal.app and iTerm start *login* shells, which
 * read ~/.bash_profile (or ~/.profile) and never source ~/.bashrc. Writing to
 * .bashrc there produces a change the user's terminal silently ignores, so
 * prefer an existing profile file when one is present.
 */
async function getConfigFileForShell(
  shellType: string,
  home: string,
): Promise<string | null> {
  const configPaths = getShellConfigPaths()

  if (shellType === 'bash') {
    for (const candidate of ['.bash_profile', '.profile']) {
      const candidatePath = join(home, candidate)
      if (await fileExists(candidatePath)) {
        return candidatePath
      }
    }
    return configPaths.bash ?? null
  }

  return configPaths[shellType] ?? null
}

/**
 * Does this line already put `binDir` on PATH? Matches any form the user might
 * have written by hand ($HOME/.local/bin, ~/.local/bin, the literal path, or
 * fish_add_path) so we never append a duplicate.
 */
function lineAddsBinDir(line: string, binDir: string, home: string): boolean {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) {
    return false
  }
  if (!/(^|\s)(export\s+PATH|PATH|set\s+-gx\s+PATH|fish_add_path)/.test(trimmed)) {
    return false
  }
  const expanded = trimmed
    .replace(/\$\{?HOME\}?/g, home)
    .replace(/(^|[\s"':])~(?=[/\s"':]|$)/g, `$1${home}`)
  return expanded
    .split(/[\s"':]+/)
    .filter(Boolean)
    .some(token => pathsEqual(token, binDir, false))
}

/**
 * Append a PATH export to the shell config on macOS/Linux.
 */
async function addToUnixPath(binDir: string): Promise<SetupMessage[]> {
  const home = osHomedir()
  const shellType = getShellType()

  if (shellType === 'unknown') {
    return [manualUnixMessage(binDir, null)]
  }

  const configFile = await getConfigFileForShell(shellType, home)
  if (!configFile) {
    return [manualUnixMessage(binDir, null)]
  }

  // A missing config file is fine — we create it by writing.
  const lines = (await readFileLines(configFile)) ?? []

  if (lines.some(line => lineAddsBinDir(line, binDir, home))) {
    logForDebugging(`PATH setup: ${binDir} already added in ${configFile}`)
    return []
  }

  // fish uses fish_add_path (idempotent in fish 3.2+) rather than export.
  const exportLine =
    shellType === 'fish'
      ? `fish_add_path ${binDir.replace(home, '$HOME')}`
      : `export PATH="${binDir.replace(home, '$HOME')}:$PATH"`

  const updated = [...lines]
  if (updated.length > 0 && updated[updated.length - 1]?.trim() !== '') {
    updated.push('')
  }
  updated.push(MARKER, exportLine, '')

  try {
    await writeFileLines(configFile, updated)
  } catch (error) {
    logForDebugging(
      `PATH setup: failed to write ${configFile}: ${errorMessage(error)}`,
      { level: 'error' },
    )
    return [manualUnixMessage(binDir, configFile)]
  }

  const displayPath = configFile.replace(home, '~')
  logForDebugging(`PATH setup: added ${binDir} to ${configFile}`)
  return [
    {
      message: `Added ${binDir.replace(home, '~')} to your PATH in ${displayPath}. Run: source ${displayPath}`,
      userActionRequired: false,
      type: 'info',
    },
  ]
}

function manualUnixMessage(
  binDir: string,
  configFile: string | null,
): SetupMessage {
  const home = osHomedir()
  const displayPath = configFile
    ? configFile.replace(home, '~')
    : 'your shell config file'
  const homeRelativeBinDir = binDir.replace(home, '$HOME')
  // fish rejects `export VAR=value`, so give fish users their own syntax.
  const command =
    getShellType() === 'fish'
      ? `echo 'fish_add_path ${homeRelativeBinDir}' >> ${displayPath} && source ${displayPath}`
      : `echo 'export PATH="${homeRelativeBinDir}:$PATH"' >> ${displayPath} && source ${displayPath}`
  return {
    message: `Could not update your PATH automatically. Run:\n\n${command}`,
    userActionRequired: true,
    type: 'path',
  }
}

/**
 * Ensure `binDir` is on the user's persisted PATH.
 *
 * Also updates process.env.PATH so a checkInstall() call later in the same
 * install run sees the new state instead of reporting a false negative (it
 * reads process.env.PATH, which does not reflect writes made after launch).
 */
export async function ensureBinDirOnPath(
  binDir: string,
): Promise<SetupMessage[]> {
  const isWindows = process.platform === 'win32'

  if (pathContainsDir(process.env.PATH ?? '', binDir, isWindows)) {
    return []
  }

  let messages: SetupMessage[]
  try {
    messages = isWindows
      ? await addToWindowsPath(binDir)
      : await addToUnixPath(binDir)
  } catch (error) {
    logForDebugging(`PATH setup failed: ${errorMessage(error)}`, {
      level: 'error',
    })
    return [
      isWindows
        ? manualWindowsMessage(binDir.replace(/\//g, '\\'))
        : manualUnixMessage(binDir, null),
    ]
  }

  // Reflect the change in this process so the subsequent PATH check agrees.
  if (!messages.some(m => m.userActionRequired)) {
    process.env.PATH = process.env.PATH
      ? `${binDir}${delimiter}${process.env.PATH}`
      : binDir
  }

  return messages
}
