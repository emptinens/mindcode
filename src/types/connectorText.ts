export type ConnectorTextBlock = {
  type: 'connector_text'
  connector_text: string
  /** Streamed connector blocks may receive their signature in a later delta. */
  signature?: string
}

export type ConnectorTextDelta = {
  type: 'connector_text_delta'
  connector_text: string
}

export function isConnectorTextBlock(
  block: unknown,
): block is ConnectorTextBlock {
  if (typeof block !== 'object' || block === null) return false

  const candidate = block as Record<string, unknown>
  return (
    candidate.type === 'connector_text' &&
    typeof candidate.connector_text === 'string'
  )
}
