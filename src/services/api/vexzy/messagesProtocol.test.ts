import { describe, expect, test } from 'bun:test'
import messageText from './fixtures/message-text.json'
import messageToolUse from './fixtures/message-tool-use.json'
import malformedEvent from './fixtures/malformed-event.json'
import reasoningEffortLowObservation from './fixtures/reasoning-effort-low-observation.json'
import streamText from './fixtures/stream-text.json'
import streamToolUse from './fixtures/stream-tool-use.json'
import {
  createVexzySseTextParser,
  parseVexzyMessage,
  parseVexzySseRecord,
  parseVexzySseText,
  parseVexzyStreamEvent,
} from './messagesProtocol.js'

type FixtureRecord = {
  event: string
  data: unknown
}

describe('Vexzy Messages-compatible protocol', () => {
  test('validates a non-stream text message and usage', () => {
    const message = parseVexzyMessage(messageText)

    expect(message.content).toEqual([
      { type: 'text', text: 'sanitized_text' },
    ])
    expect(message.stop_reason).toBe('end_turn')
    expect(message.usage).toEqual({ input_tokens: 3, output_tokens: 2 })
  })

  test('validates a tool_use message', () => {
    const message = parseVexzyMessage(messageToolUse)
    const tool = message.content[0]

    expect(tool).toMatchObject({
      type: 'tool_use',
      id: 'tool_fixture',
      name: 'tool_fixture',
      input: { city: 'sanitized_city' },
    })
    expect(message.stop_reason).toBe('tool_use')
  })

  test('preserves unknown provider fields on known messages, blocks, and events', () => {
    const message = parseVexzyMessage({
      ...messageText,
      provider_message_field: { preserved: true },
      content: [
        {
          ...messageText.content[0],
          provider_block_field: 'preserved',
        },
      ],
      usage: {
        ...messageText.usage,
        provider_usage_field: 7,
      },
    })
    const event = parseVexzyStreamEvent({
      type: 'content_block_delta',
      index: 0,
      provider_event_field: 'preserved',
      delta: {
        type: 'text_delta',
        text: 'sanitized_text',
        provider_delta_field: true,
      },
    })

    expect(message).toMatchObject({
      provider_message_field: { preserved: true },
      content: [{ provider_block_field: 'preserved' }],
      usage: { provider_usage_field: 7 },
    })
    expect(event).toMatchObject({
      provider_event_field: 'preserved',
      delta: { provider_delta_field: true },
    })
  })

  test('validates fragmented text deltas and streaming usage', () => {
    const records = streamText as FixtureRecord[]
    const events = records.map(record => parseVexzySseRecord(record))
    const text = events
      .filter(event => event.type === 'content_block_delta')
      .map(event => event.delta)
      .filter(delta => delta.type === 'text_delta')
      .map(delta => delta.text)
      .join('')
    const messageDelta = events.find(event => event.type === 'message_delta')

    expect(text).toBe('sanitized_text')
    expect(messageDelta).toMatchObject({
      usage: { output_tokens: 2 },
      delta: { stop_reason: 'end_turn', stop_sequence: null },
    })
  })

  test('validates tool_use and fragmented input_json_delta events', () => {
    const records = streamToolUse as FixtureRecord[]
    const events = records.map(record => parseVexzySseRecord(record))
    const blockStart = events.find(
      (event): event is Extract<typeof event, { type: 'content_block_start' }> =>
        event.type === 'content_block_start',
    )
    const fragments = events
      .filter(event => event.type === 'content_block_delta')
      .map(event => event.delta)
      .filter(delta => delta.type === 'input_json_delta')
      .map(delta => delta.partial_json)

    expect(blockStart?.content_block).toMatchObject({
      type: 'tool_use',
      id: 'tool_fixture',
      name: 'tool_fixture',
    })
    expect(JSON.parse(fragments.join(''))).toEqual({
      city: 'sanitized_city',
    })
    expect(
      events.find(event => event.type === 'message_delta'),
    ).toMatchObject({
      usage: { output_tokens: 4 },
      delta: { stop_reason: 'tool_use' },
    })
  })

  test('rejects malformed event and mismatched SSE event name', () => {
    expect(() => parseVexzySseRecord(malformedEvent)).toThrow()
    expect(() =>
      parseVexzyStreamEvent({ type: 'unknown_event' }),
    ).toThrow()
    expect(() =>
      parseVexzySseRecord({
        event: 'ping',
        data: JSON.stringify({ type: 'message_stop' }),
      }),
    ).toThrow()
  })

  test('frames CRLF SSE across raw chunks and dispatches on a blank line', () => {
    const parser = createVexzySseTextParser()
    const chunks = [
      'event: message_',
      'stop\r',
      '\ndata: {"type":"message_',
      'stop"}\r\n',
      '\r',
      '\n',
    ]
    const events = chunks.flatMap(chunk => parser.push(chunk))

    expect(events).toEqual([{ type: 'message_stop' }])
    expect(parser.finish()).toEqual([])
  })

  test('frames multiple LF events and joins multiple data fields', () => {
    const records = streamText as FixtureRecord[]
    const raw = records
      .map(
        record =>
          `event: ${record.event}\ndata: ${JSON.stringify(record.data)}\n\n`,
      )
      .join('')
    const parser = createVexzySseTextParser()
    const events = []

    for (let offset = 0; offset < raw.length; offset += 7) {
      events.push(...parser.push(raw.slice(offset, offset + 7)))
    }
    events.push(...parser.finish())

    expect(events.map(event => event.type)).toEqual(
      records.map(record => parseVexzyStreamEvent(record.data).type),
    )
    expect(
      parseVexzySseText(
        'event: ping\ndata: {\ndata: "type":"ping"\ndata: }\n\n',
      ),
    ).toEqual([{ type: 'ping' }])
  })

  test('rejects an SSE frame without blank-line termination', () => {
    const parser = createVexzySseTextParser()
    expect(
      parser.push('event: ping\ndata: {"type":"ping"}\n'),
    ).toEqual([])
    expect(() => parser.finish()).toThrow('blank line')
  })

  test('records the accepted low-reasoning probe without new wire types', () => {
    expect(reasoningEffortLowObservation).toEqual({
      reasoning_effort: 'low',
      result: 'accepted',
      new_event_types: [],
      new_block_types: [],
      new_delta_types: [],
    })
  })
})
