import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { resolveAttachments, validateAttachmentPaths } from './attachments.js'

describe('BriefTool local attachments', () => {
  test('resolves local files without provider file identifiers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mindcode-brief-'))
    const filePath = join(directory, 'sample.txt')
    await writeFile(filePath, 'local attachment')

    expect(await validateAttachmentPaths([filePath])).toEqual({ result: true })
    await expect(resolveAttachments([filePath])).resolves.toEqual([
      {
        path: filePath,
        size: 16,
        isImage: false,
      },
    ])
  })
})
