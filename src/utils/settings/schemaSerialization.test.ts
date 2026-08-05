import { expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { toSettingsJSONSchema } from './schemaSerialization.js'

test('settings JSON Schema tolerates optional undefined branches', () => {
  const schema = toSettingsJSONSchema(
    z.object({
      effortLevel: z
        .enum(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
        .optional()
        .catch(undefined),
      enabledPlugins: z.record(
        z.string(),
        z.union([z.array(z.string()), z.boolean(), z.undefined()]),
      ),
    }),
  ) as {
    properties?: {
      effortLevel?: { type?: string; enum?: string[] }
    }
  }

  expect(schema.properties?.effortLevel).toMatchObject({
    type: 'string',
    enum: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  })
})
