import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'

type TranscriptShareResult = {
  success: boolean
  transcriptId?: string
}

export type TranscriptShareTrigger =
  | 'bad_feedback_survey'
  | 'good_feedback_survey'
  | 'frustration'
  | 'memory_survey'

/**
 * Compatibility entry point for transcript sharing.
 * Transcript data is neither read nor sent; survey callers receive a
 * deterministic local failure and can close their existing prompt.
 */
export async function submitTranscriptShare(
  messages: Message[],
  trigger: TranscriptShareTrigger,
  appearanceId: string,
): Promise<TranscriptShareResult> {
  void messages
  void trigger
  void appearanceId
  logForDebugging('Transcript sharing is disabled; no transcript was collected')
  return { success: false }
}
