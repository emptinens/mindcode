import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getCurrentSessionSidecarPath } from './sessionSidecar.js'

export type PinnedMessage = {
  uuid: string
  preview: string
  role: 'user' | 'assistant'
  pinnedAt: number
}

const SIDECAR_SUFFIX = '.pins'
const listeners = new Set<() => void>()

let cachedPath: string | null = null
let cachedPins: PinnedMessage[] | null = null

function getStatePath(): string {
  return getCurrentSessionSidecarPath(SIDECAR_SUFFIX)
}

function isPinnedMessage(value: unknown): value is PinnedMessage {
  if (!value || typeof value !== 'object') return false
  const pin = value as Partial<PinnedMessage>
  return (
    typeof pin.uuid === 'string' &&
    typeof pin.preview === 'string' &&
    (pin.role === 'user' || pin.role === 'assistant') &&
    typeof pin.pinnedAt === 'number'
  )
}

function loadPins(path: string): PinnedMessage[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    return Array.isArray(parsed) ? parsed.filter(isPinnedMessage) : []
  } catch {
    return []
  }
}

function getPins(): PinnedMessage[] {
  const path = getStatePath()
  if (path !== cachedPath || cachedPins === null) {
    cachedPath = path
    cachedPins = loadPins(path)
  }
  return cachedPins
}

function savePins(pins: PinnedMessage[]): void {
  const path = getStatePath()
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, JSON.stringify(pins, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    })
  } catch {
    // Pinning is still useful for the current process if persistence fails.
  }
}

function notify(): void {
  for (const listener of listeners) listener()
}

export function getPinnedMessages(): PinnedMessage[] {
  return getPins()
}

export function isPinned(uuid: string): boolean {
  return getPins().some(pin => pin.uuid === uuid)
}

export function pinMessage(pin: PinnedMessage): void {
  const next = [pin, ...getPins().filter(existing => existing.uuid !== pin.uuid)]
  cachedPath = getStatePath()
  cachedPins = next
  savePins(next)
  notify()
}

export function unpinMessage(uuid: string): void {
  const next = getPins().filter(pin => pin.uuid !== uuid)
  cachedPath = getStatePath()
  cachedPins = next
  savePins(next)
  notify()
}

export function subscribePins(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
