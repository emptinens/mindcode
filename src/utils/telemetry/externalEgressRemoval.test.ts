import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../..')
const telemetryDir = resolve(root, 'src/utils/telemetry')
const packageJson = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8'),
) as { dependencies?: Record<string, string> }

const previousEnv = new Map<string, string | undefined>()

function setTestEnv(key: string, value: string): void {
  if (!previousEnv.has(key)) previousEnv.set(key, process.env[key])
  process.env[key] = value
}

afterEach(() => {
  for (const [key, value] of previousEnv) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
  previousEnv.clear()
})

describe('local telemetry boundary', () => {
  test('removes runtime exporters, endpoints, and unreachable compatibility modules', () => {
    for (const file of readdirSync(telemetryDir)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
      const source = readFileSync(resolve(telemetryDir, file), 'utf8')
      for (const forbidden of [
        '@opentelemetry/exporter-',
        'OTEL_EXPORTER_OTLP',
        'BETA_TRACING_ENDPOINT',
        'ENABLE_BETA_TRACING_DETAILED',
        'new OTLP',
        'BigQueryMetricsExporter',
        'MindCodeDiagLogger',
      ]) {
        expect(source, `${file} contains ${forbidden}`).not.toContain(forbidden)
      }
    }

    for (const removed of [
      'instrumentation.ts',
      'bigqueryExporter.ts',
      'logger.ts',
    ]) {
      expect(existsSync(resolve(telemetryDir, removed))).toBe(false)
    }

    const dependencies = Object.keys(packageJson.dependencies ?? {})
    expect(dependencies.filter((name) => name.startsWith('@opentelemetry/exporter-'))).toEqual([])
  })

  test('does not create a network request while local sinks and survey sharing run', async () => {
    const originalFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (() => {
      fetchCalls += 1
      throw new Error('telemetry network access')
    }) as unknown as typeof fetch

    try {
      const analytics = await import('../../services/analytics/index.js')
      const { initializeAnalyticsSink } = await import(
        '../../services/analytics/sink.js'
      )
      const { submitTranscriptShare } = await import(
        '../../components/FeedbackSurvey/submitTranscriptShare.js'
      )

      const betaKey = ['BETA', 'TRACING', 'ENDPOINT'].join('_')
      const exporterKey = ['OTEL', 'EXPORTER', 'OTLP', 'ENDPOINT'].join('_')
      setTestEnv(betaKey, 'https://telemetry.invalid')
      setTestEnv(exporterKey, 'https://telemetry.invalid')

      analytics._resetForTesting()
      initializeAnalyticsSink()
      analytics.logEvent('local_boundary_test', { count: 1 })
      await analytics.logEventAsync('local_boundary_test', { count: 2 })

      const result = await submitTranscriptShare(
        [],
        'bad_feedback_survey',
        'local-test',
      )

      expect(result).toEqual({ success: false })
      expect(analytics.getLocalEventCounts()).toEqual({
        local_boundary_test: 2,
      })
      expect(fetchCalls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
