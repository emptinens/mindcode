import { z } from 'zod'

const nonNegativeInteger = z.number().int().nonnegative()
const nullableString = z.string().nullable()

export const vexzyUsageSchema = z
  .object({
    input_tokens: nonNegativeInteger,
    output_tokens: nonNegativeInteger,
  })
  .passthrough()

export const vexzyStreamUsageSchema = z
  .object({
    output_tokens: nonNegativeInteger,
  })
  .passthrough()

export const vexzyTextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
}).passthrough()

export const vexzyToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.unknown()),
}).passthrough()

export const vexzyContentBlockSchema = z.discriminatedUnion('type', [
  vexzyTextBlockSchema,
  vexzyToolUseBlockSchema,
])

export const vexzyMessageSchema = z
  .object({
    type: z.literal('message'),
    id: z.string().min(1),
    role: z.literal('assistant'),
    model: z.string().min(1),
    content: z.array(vexzyContentBlockSchema),
    stop_reason: nullableString,
    stop_sequence: nullableString,
    usage: vexzyUsageSchema,
  })
  .passthrough()

export const vexzyMessageStartEventSchema = z
  .object({
    type: z.literal('message_start'),
    message: vexzyMessageSchema,
  })
  .passthrough()

export const vexzyPingEventSchema = z
  .object({
    type: z.literal('ping'),
  })
  .passthrough()

export const vexzyContentBlockStartEventSchema = z
  .object({
    type: z.literal('content_block_start'),
    index: nonNegativeInteger,
    content_block: vexzyContentBlockSchema,
  })
  .passthrough()

export const vexzyTextDeltaSchema = z
  .object({
    type: z.literal('text_delta'),
    text: z.string(),
  })
  .passthrough()

export const vexzyInputJsonDeltaSchema = z
  .object({
    type: z.literal('input_json_delta'),
    partial_json: z.string(),
  })
  .passthrough()

export const vexzyContentBlockDeltaEventSchema = z
  .object({
    type: z.literal('content_block_delta'),
    index: nonNegativeInteger,
    delta: z.discriminatedUnion('type', [
      vexzyTextDeltaSchema,
      vexzyInputJsonDeltaSchema,
    ]),
  })
  .passthrough()

export const vexzyContentBlockStopEventSchema = z
  .object({
    type: z.literal('content_block_stop'),
    index: nonNegativeInteger,
  })
  .passthrough()

export const vexzyMessageDeltaSchema = z
  .object({
    stop_reason: nullableString,
    stop_sequence: nullableString,
  })
  .passthrough()

export const vexzyMessageDeltaEventSchema = z
  .object({
    type: z.literal('message_delta'),
    delta: vexzyMessageDeltaSchema,
    usage: vexzyStreamUsageSchema,
  })
  .passthrough()

export const vexzyMessageStopEventSchema = z
  .object({
    type: z.literal('message_stop'),
  })
  .passthrough()

export const vexzyStreamEventSchema = z.discriminatedUnion('type', [
  vexzyMessageStartEventSchema,
  vexzyPingEventSchema,
  vexzyContentBlockStartEventSchema,
  vexzyContentBlockDeltaEventSchema,
  vexzyContentBlockStopEventSchema,
  vexzyMessageDeltaEventSchema,
  vexzyMessageStopEventSchema,
])

export const vexzySseRecordSchema = z
  .object({
    event: z.string().min(1),
    data: z.unknown(),
  })
  .passthrough()

export type VexzyUsage = z.infer<typeof vexzyUsageSchema>
export type VexzyStreamUsage = z.infer<typeof vexzyStreamUsageSchema>
export type VexzyTextBlock = z.infer<typeof vexzyTextBlockSchema>
export type VexzyToolUseBlock = z.infer<typeof vexzyToolUseBlockSchema>
export type VexzyContentBlock = z.infer<typeof vexzyContentBlockSchema>
export type VexzyMessage = z.infer<typeof vexzyMessageSchema>
export type VexzyTextDelta = z.infer<typeof vexzyTextDeltaSchema>
export type VexzyInputJsonDelta = z.infer<typeof vexzyInputJsonDeltaSchema>
export type VexzyStreamEvent = z.infer<typeof vexzyStreamEventSchema>
export type VexzySseRecord = z.infer<typeof vexzySseRecordSchema>

export interface VexzySseTextParser {
  push(chunk: string): VexzyStreamEvent[]
  finish(): VexzyStreamEvent[]
}

export function parseVexzyMessage(input: unknown): VexzyMessage {
  return vexzyMessageSchema.parse(input)
}

export function parseVexzyStreamEvent(input: unknown): VexzyStreamEvent {
  return vexzyStreamEventSchema.parse(input)
}

export function parseVexzySseRecord(input: unknown): VexzyStreamEvent {
  const record = vexzySseRecordSchema.parse(input)
  const payload =
    typeof record.data === 'string' ? parseJsonData(record.data) : record.data
  const event = parseVexzyStreamEvent(payload)

  if (record.event !== event.type) {
    throw new Error('Vexzy SSE event name does not match payload type')
  }

  return event
}

export function createVexzySseTextParser(): VexzySseTextParser {
  let lineBuffer = ''
  let eventName: string | undefined
  let dataLines: string[] = []
  let finished = false

  const resetFrame = (): void => {
    eventName = undefined
    dataLines = []
  }

  const dispatchFrame = (): VexzyStreamEvent | undefined => {
    if (dataLines.length === 0) {
      resetFrame()
      return undefined
    }
    if (eventName === undefined) {
      throw new Error('Vexzy SSE frame is missing an event field')
    }

    const event = parseVexzySseRecord({
      event: eventName,
      data: dataLines.join('\n'),
    })
    resetFrame()
    return event
  }

  const consumeLine = (
    line: string,
    events: VexzyStreamEvent[],
  ): void => {
    if (line.length === 0) {
      const event = dispatchFrame()
      if (event !== undefined) events.push(event)
      return
    }
    if (line.startsWith(':')) return

    const colonIndex = line.indexOf(':')
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex)
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'event') {
      eventName = value
    } else if (field === 'data') {
      dataLines.push(value)
    }
  }

  const drainLines = (atEnd: boolean): VexzyStreamEvent[] => {
    const events: VexzyStreamEvent[] = []

    while (true) {
      const ending = findLineEnding(lineBuffer, atEnd)
      if (ending === undefined) break

      const line = lineBuffer.slice(0, ending.index)
      lineBuffer = lineBuffer.slice(ending.index + ending.length)
      consumeLine(line, events)
    }

    if (atEnd && lineBuffer.length > 0) {
      consumeLine(lineBuffer, events)
      lineBuffer = ''
    }

    return events
  }

  return {
    push(chunk: string): VexzyStreamEvent[] {
      if (finished) throw new Error('Vexzy SSE parser is already finished')
      lineBuffer += chunk
      return drainLines(false)
    },
    finish(): VexzyStreamEvent[] {
      if (finished) throw new Error('Vexzy SSE parser is already finished')
      finished = true
      const events = drainLines(true)
      if (eventName !== undefined || dataLines.length > 0) {
        throw new Error('Vexzy SSE stream ended before a blank line')
      }
      return events
    },
  }
}

export function parseVexzySseText(input: string): VexzyStreamEvent[] {
  const parser = createVexzySseTextParser()
  return [...parser.push(input), ...parser.finish()]
}

interface LineEnding {
  readonly index: number
  readonly length: 1 | 2
}

function findLineEnding(
  input: string,
  atEnd: boolean,
): LineEnding | undefined {
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]
    if (character === '\n') return { index, length: 1 }
    if (character !== '\r') continue

    const next = input[index + 1]
    if (next === '\n') return { index, length: 2 }
    if (next !== undefined || atEnd) return { index, length: 1 }
    return undefined
  }

  return undefined
}

function parseJsonData(data: string): unknown {
  try {
    return JSON.parse(data) as unknown
  } catch {
    throw new Error('Vexzy SSE data is not valid JSON')
  }
}
