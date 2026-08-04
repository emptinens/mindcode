import { z } from 'zod/v4'
import { type ToolDef, type ValidationResult, buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getSftp } from '../../utils/ssh/sshSessionManager.js'
import { SFTP_TOOL_NAME, getSftpPrompt } from './prompt.js'

// NOTE: the top-level input schema must be a plain object — the API rejects a
// top-level anyOf/oneOf (which a discriminated union produces). So this is one
// flat object with `action` as the discriminant and the path fields optional;
// validateInput enforces which are required for each action.
const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['upload', 'download', 'list', 'mkdir', 'remove'])
      .describe(
        'Operation: "upload"/"download" transfer a file, "list" reads a directory, "mkdir" creates one, "remove" deletes a file.',
      ),
    sessionId: z.string().describe('An open Ssh session id (from the Ssh tool).'),
    remotePath: z
      .string()
      .describe(
        'Path on the SSH host: file to upload-to/download-from/remove, or directory to list/create.',
      ),
    localPath: z
      .string()
      .optional()
      .describe(
        'Path on THIS machine. Required for "upload" (source) and "download" (destination).',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type RemoteEntry = { name: string; size: number; isDirectory: boolean; mode: number }

export type SftpOutput =
  | { kind: 'uploaded'; localPath: string; remotePath: string }
  | { kind: 'downloaded'; remotePath: string; localPath: string }
  | { kind: 'list'; remotePath: string; entries: RemoteEntry[] }
  | { kind: 'mkdir'; remotePath: string }
  | { kind: 'removed'; remotePath: string }

export const SftpTool = buildTool({
  name: SFTP_TOOL_NAME,
  searchHint: 'sftp file upload download over ssh transfer',
  maxResultSizeChars: 100_000,
  async description(input) {
    switch (input.action) {
      case 'upload':
        return `SFTP upload ${input.localPath} -> ${input.remotePath}`
      case 'download':
        return `SFTP download ${input.remotePath} -> ${input.localPath}`
      case 'list':
        return `SFTP list ${input.remotePath}`
      case 'mkdir':
        return `SFTP mkdir ${input.remotePath}`
      case 'remove':
        return `SFTP remove ${input.remotePath}`
    }
  },
  userFacingName() {
    return 'SFTP'
  },
  renderToolUseMessage(input) {
    switch (input.action) {
      case 'upload':
        return `upload ${input.localPath ?? '?'} → ${input.remotePath}`
      case 'download':
        return `download ${input.remotePath} → ${input.localPath ?? '?'}`
      case 'list':
        return `list ${input.remotePath}`
      case 'mkdir':
        return `mkdir ${input.remotePath}`
      case 'remove':
        return `remove ${input.remotePath}`
      default:
        return null
    }
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly(input) {
    return input.action === 'list' || input.action === 'download'
  },
  isDestructive(input) {
    return input.action === 'remove' || input.action === 'upload'
  },
  async validateInput(input): Promise<ValidationResult> {
    if (
      (input.action === 'upload' || input.action === 'download') &&
      !input.localPath
    ) {
      return {
        result: false,
        message: `Error: "localPath" is required for action "${input.action}".`,
        errorCode: 1,
      }
    }
    return { result: true }
  },
  async prompt() {
    return getSftpPrompt()
  },
  async call(input) {
    const sftp = await getSftp(input.sessionId)

    switch (input.action) {
      case 'upload': {
        // validateInput guarantees localPath is present here.
        const localPath = input.localPath as string
        await new Promise<void>((resolve, reject) => {
          sftp.fastPut(localPath, input.remotePath, err =>
            err ? reject(new Error(`upload failed: ${err.message}`)) : resolve(),
          )
        })
        return { data: { kind: 'uploaded', localPath, remotePath: input.remotePath } }
      }
      case 'download': {
        const localPath = input.localPath as string
        await new Promise<void>((resolve, reject) => {
          sftp.fastGet(input.remotePath, localPath, err =>
            err ? reject(new Error(`download failed: ${err.message}`)) : resolve(),
          )
        })
        return { data: { kind: 'downloaded', remotePath: input.remotePath, localPath } }
      }
      case 'list': {
        const entries = await new Promise<RemoteEntry[]>((resolve, reject) => {
          sftp.readdir(input.remotePath, (err, list) => {
            if (err) {
              reject(new Error(`list failed: ${err.message}`))
              return
            }
            resolve(
              list.map(e => ({
                name: e.filename,
                size: e.attrs.size,
                isDirectory: e.attrs.isDirectory(),
                mode: e.attrs.mode,
              })),
            )
          })
        })
        return { data: { kind: 'list', remotePath: input.remotePath, entries } }
      }
      case 'mkdir': {
        await new Promise<void>((resolve, reject) => {
          sftp.mkdir(input.remotePath, err =>
            err ? reject(new Error(`mkdir failed: ${err.message}`)) : resolve(),
          )
        })
        return { data: { kind: 'mkdir', remotePath: input.remotePath } }
      }
      case 'remove': {
        await new Promise<void>((resolve, reject) => {
          sftp.unlink(input.remotePath, err =>
            err ? reject(new Error(`remove failed: ${err.message}`)) : resolve(),
          )
        })
        return { data: { kind: 'removed', remotePath: input.remotePath } }
      }
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    let content: string
    switch (output.kind) {
      case 'uploaded':
        content = `Uploaded ${output.localPath} -> ${output.remotePath}`
        break
      case 'downloaded':
        content = `Downloaded ${output.remotePath} -> ${output.localPath}`
        break
      case 'list':
        content = output.entries.length
          ? `${output.remotePath}:\n${output.entries
              .map(e => `${e.isDirectory ? 'd' : '-'} ${String(e.size).padStart(10)}  ${e.name}`)
              .join('\n')}`
          : `${output.remotePath}: (empty)`
        break
      case 'mkdir':
        content = `Created remote directory ${output.remotePath}`
        break
      case 'removed':
        content = `Removed remote file ${output.remotePath}`
        break
    }
    return { tool_use_id: toolUseID, type: 'tool_result', content }
  },
} satisfies ToolDef<InputSchema, SftpOutput>)
