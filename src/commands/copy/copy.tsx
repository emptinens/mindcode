import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setClipboard } from '../../ink/termio/osc.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  collectRecentAssistantTexts,
  resolveCopyIndex,
} from './copyLogic.js'

export { collectRecentAssistantTexts, resolveCopyIndex } from './copyLogic.js'

const COPY_DIR = join(tmpdir(), 'mindcode')
const RESPONSE_FILENAME = 'response.md'
async function persistFallback(text: string): Promise<string> {
  await mkdir(COPY_DIR, { recursive: true })
  const path = join(COPY_DIR, RESPONSE_FILENAME)
  await writeFile(path, text, 'utf8')
  return path
}

async function copyResponse(text: string): Promise<string> {
  const fallbackPath = await persistFallback(text)
  try {
    const terminalSequence = await setClipboard(text)
    if (terminalSequence) process.stdout.write(terminalSequence)
    return `Copied ${text.length} characters. Backup: ${fallbackPath}`
  } catch {
    return `Clipboard unavailable. Response saved: ${fallbackPath}`
  }
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const texts = collectRecentAssistantTexts(context.messages)
  if (texts.length === 0) {
    onDone('No assistant message to copy')
    return null
  }

  const selection = resolveCopyIndex(args, texts.length)
  if ('error' in selection) {
    onDone(selection.error)
    return null
  }

  onDone(await copyResponse(texts[selection.index]!))
  return null
}
