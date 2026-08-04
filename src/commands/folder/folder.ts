import { execFile } from 'child_process'
import type { LocalCommandCall } from '../../types/command.js'
import { getCwd } from '../../utils/cwd.js'

export const call: LocalCommandCall = async () => {
  const cwd = getCwd()

  const opener =
    process.platform === 'win32' ? 'explorer'
    : process.platform === 'darwin' ? 'open'
    : 'xdg-open'

  execFile(opener, [cwd])

  return { type: 'text', value: `Opened ${cwd}` }
}
