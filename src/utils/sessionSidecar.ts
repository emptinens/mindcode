import { dirname, join } from 'node:path'
import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
} from '../bootstrap/state.js'
import { getMindCodeConfigHomeDir } from './envUtils.js'
import { sanitizePath } from './path.js'

function getCurrentSessionDirectory(): string {
  return (
    getSessionProjectDir() ??
    join(
      getMindCodeConfigHomeDir(),
      'projects',
      sanitizePath(getOriginalCwd()),
    )
  )
}

export function getCurrentSessionSidecarPath(suffix: string): string {
  return join(getCurrentSessionDirectory(), `${getSessionId()}${suffix}`)
}

export function getSessionSidecarPathForTranscript(
  transcriptPath: string,
  sessionId: string,
  suffix: string,
): string {
  return join(dirname(transcriptPath), `${sessionId}${suffix}`)
}
