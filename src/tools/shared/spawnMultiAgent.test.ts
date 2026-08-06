import { describe, expect, test } from 'bun:test'

describe('worker runtime ingress paths', () => {
  test('all scoped worker ingress modules use the canonical runtime resolver', async () => {
    const paths = [
      '../AgentTool/runAgent.ts',
      '../AgentTool/AgentTool.tsx',
      '../AgentTool/resumeAgent.ts',
      './spawnMultiAgent.ts',
      '../../utils/swarm/backends/InProcessBackend.ts',
      '../../utils/swarm/backends/PaneBackendExecutor.ts',
      '../../utils/swarm/inProcessRunner.ts',
      '../../utils/swarm/spawnInProcess.ts',
      '../../utils/swarm/teammateInit.ts',
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

  test('every runAgent production caller supplies an explicit policy pair', async () => {
    const paths = [
      '../../services/MagicDocs/magicDocs.ts',
      '../AgentTool/AgentTool.tsx',
      '../AgentTool/resumeAgent.ts',
      '../SkillTool/SkillTool.ts',
      '../WorkflowTool/subagent.ts',
      '../../utils/processUserInput/processSlashCommand.tsx',
      '../../utils/swarm/inProcessRunner.ts',
    ]

    for (const path of paths) {
      const source = await Bun.file(new URL(path, import.meta.url)).text()
      expect(source).toContain('policyEpoch:')
      expect(source).toContain('policyDigest:')
    }

    const runAgentSource = await Bun.file(
      new URL('../AgentTool/runAgent.ts', import.meta.url),
    ).text()
    expect(runAgentSource).not.toContain('getWorkerPolicyIdentity')
    expect(runAgentSource).toContain('policyEpoch: number')
    expect(runAgentSource).toContain('policyDigest: string')
  })

  test('the in-process backend forwards one admitted policy pair to spawn and run', async () => {
    const source = await Bun.file(
      new URL(
        '../../utils/swarm/backends/InProcessBackend.ts',
        import.meta.url,
      ),
    ).text()

    expect(source).toContain("'In-process Worker'")
    expect(source.match(/policyEpoch: workerPolicy\.policyEpoch/g)).toHaveLength(2)
    expect(source.match(/policyDigest: workerPolicy\.policyDigest/g)).toHaveLength(2)
  })
})
