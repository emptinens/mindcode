import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getCurrentSessionSidecarPath } from './sessionSidecar.js'

export type JailbreakLevel = 'disabled' | 'lowered' | 'full'

const DEFAULT_LEVEL: JailbreakLevel = 'lowered'
const SIDECAR_SUFFIX = '.jailbreak'

let cachedPath: string | null = null
let cachedLevel: JailbreakLevel | null = null

export function parseJailbreakLevel(
  value: string,
): JailbreakLevel | undefined {
  const normalized = value.trim().toLowerCase()
  if (
    normalized === 'disabled' ||
    normalized === 'lowered' ||
    normalized === 'full'
  ) {
    return normalized
  }

  // Migrate sidecars written by the old boolean toggle.
  if (normalized === 'true') return 'full'
  if (normalized === 'false') return 'disabled'
  return undefined
}

export function readJailbreakLevelFromPath(
  path: string,
): JailbreakLevel | undefined {
  try {
    return parseJailbreakLevel(readFileSync(path, 'utf-8'))
  } catch {
    return undefined
  }
}

function getStatePath(): string {
  return getCurrentSessionSidecarPath(SIDECAR_SUFFIX)
}

export function getJailbreakLevel(): JailbreakLevel {
  const path = getStatePath()
  if (path !== cachedPath) {
    cachedPath = path
    cachedLevel = readJailbreakLevelFromPath(path) ?? DEFAULT_LEVEL
  }
  return cachedLevel ?? DEFAULT_LEVEL
}

export function setJailbreakLevel(level: JailbreakLevel): void {
  const path = getStatePath()
  cachedPath = path
  cachedLevel = level
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, level, { encoding: 'utf-8', mode: 0o600 })
  } catch {
    // Persistence is best-effort; the in-memory value is still active.
  }
}
