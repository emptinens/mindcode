/**
 * Compatibility surface for former event call sites.
 *
 * Event payloads are never exported. Prompt/tool content is always redacted,
 * and the event sink intentionally performs no I/O.
 */

export function redactIfDisabled(_content: string): string {
  return '<REDACTED>'
}

export async function logOTelEvent(
  _eventName: string,
  _metadata: { [key: string]: string | undefined } = {},
): Promise<void> {
  return
}
