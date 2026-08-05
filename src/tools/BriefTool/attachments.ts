/**
 * Shared attachment validation + resolution for SendUserMessage and
 * SendUserFile. Lives in BriefTool/ so the dynamic `./upload.js` import
 * inside the feature('BRIDGE_MODE') guard stays relative and upload.ts
 * (axios, crypto, auth utils) remains tree-shakeable from non-bridge builds.
 */

import { stat } from 'fs/promises'

import type { ValidationResult } from '../../Tool.js'

import { getCwd } from '../../utils/cwd.js'
import { getErrnoCode } from '../../utils/errors.js'
import { IMAGE_EXTENSION_REGEX } from '../../utils/imagePaste.js'
import { expandPath } from '../../utils/path.js'

export type ResolvedAttachment = {
  path: string
  size: number
  isImage: boolean
  file_uuid?: string
}

export async function validateAttachmentPaths(
  rawPaths: string[],
): Promise<ValidationResult> {
  const cwd = getCwd()
  for (const rawPath of rawPaths) {
    const fullPath = expandPath(rawPath)
    try {
      const stats = await stat(fullPath)
      if (!stats.isFile()) {
        return {
          result: false,
          message: `Attachment "${rawPath}" is not a regular file.`,
          errorCode: 1,
        }
      }
    } catch (e) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT') {
        return {
          result: false,
          message: `Attachment "${rawPath}" does not exist. Current working directory: ${cwd}.`,
          errorCode: 1,
        }
      }
      if (code === 'EACCES' || code === 'EPERM') {
        return {
          result: false,
          message: `Attachment "${rawPath}" is not accessible (permission denied).`,
          errorCode: 1,
        }
      }
      throw e
    }
  }
  return { result: true }
}

export async function resolveAttachments(
  rawPaths: string[],
): Promise<ResolvedAttachment[]> {
  // Stat serially to keep ordering deterministic. Attachments remain local
  // paths; remote-control upload is no longer part of the runtime.
  const stated: ResolvedAttachment[] = []
  for (const rawPath of rawPaths) {
    const fullPath = expandPath(rawPath)
    // Single stat — we need size, so this is the operation, not a guard.
    // validateInput ran before us, but the file could have moved since
    // (TOCTOU); if it did, let the error propagate so the model sees it.
    const stats = await stat(fullPath)
    stated.push({
      path: fullPath,
      size: stats.size,
      isImage: IMAGE_EXTENSION_REGEX.test(fullPath),
    })
  }
  return stated
}
