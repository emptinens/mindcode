/**
 * Settings Sync Types
 *
 * Compatibility types for the local settings-sync boundary.
 */

import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

/**
 * Content portion of user sync data - flat key-value storage.
 * Keys are opaque strings (typically file paths).
 * Values are UTF-8 string content (JSON, Markdown, etc).
 */
export const UserSyncContentSchema = lazySchema(() =>
  z.object({
    entries: z.record(z.string(), z.string()),
  }),
)

/**
 * Historical response shape retained for source compatibility.
 */
export const UserSyncDataSchema = lazySchema(() =>
  z.object({
    userId: z.string(),
    version: z.number(),
    lastModified: z.string(), // ISO 8601 timestamp
    checksum: z.string(), // MD5 hash
    content: UserSyncContentSchema(),
  }),
)

export type UserSyncData = z.infer<ReturnType<typeof UserSyncDataSchema>>

/**
 * Result from fetching user settings
 */
export type SettingsSyncFetchResult = {
  success: boolean
  data?: UserSyncData
  isEmpty?: boolean // true if 404 (no data exists)
  error?: string
  skipRetry?: boolean
}

/**
 * Result from uploading user settings
 */
export type SettingsSyncUploadResult = {
  success: boolean
  checksum?: string
  lastModified?: string
  error?: string
}

/**
 * Keys used for sync entries
 */
export const SYNC_KEYS = {
  USER_SETTINGS: '~/.mindcode/settings.json',
  USER_MEMORY: '~/.mindcode/MINDCODE.md',
  projectSettings: (projectId: string) =>
    `projects/${projectId}/.mindcode/settings.local.json`,
  projectMemory: (projectId: string) => `projects/${projectId}/MINDCODE.local.md`,
} as const
