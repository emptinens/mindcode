import { describe, expect, test } from 'bun:test'

describe('worker runtime ingress paths', () => {
  test('all scoped worker ingress modules use the canonical runtime resolver', async () => {
    const paths = [
      '../AgentTool/runAgent.ts',
      '../AgentTool/AgentTool.tsx',
      './spawnMultiAgent.ts',
      '../../utils/swarm/spawnInProcess.ts',
    ]

    for (const path of paths) {
      const source = await Bun.file(
        new URL(path, import.meta.url),
      ).text()
      expect(source).toContain('resolveWorkerRuntime')
      expect(source.match(/\bresolveWorkerRuntime\(/g)?.length ?? 0).toBeGreaterThan(0)
      expect(source).not.toContain('resolveWorkerEffort(')
    }
  })

  test('out-of-process workers share a leader-issued lifecycle run id', async () => {
    const source = await Bun.file(
      new URL('./spawnMultiAgent.ts', import.meta.url),
    ).text()

    expect(source).toContain('createWorkerLifecycleRunId()')
    expect(source).toContain('WORKER_LIFECYCLE_RUN_ID_ENV')
    expect(source).toContain('workerRunId,')
    expect(source).toContain('lifecycleStartedAtMs,')
  })
})
