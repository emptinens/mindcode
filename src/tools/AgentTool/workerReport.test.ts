import { describe, expect, test } from 'bun:test'
import {
  appendWorkerReportEvidence,
  buildWorkerReport as buildWorkerReportProduction,
  buildWorkerReportInstruction,
  deriveWorkerReportId,
  isWorkerReportCompletionEligible,
  serializeWorkerReport,
  workerReportSchema,
  type WorkerReport,
} from './workerReport.js'

const STABLE_POLICY_IDENTITY = {
  policyEpoch: 7,
  policyDigest: 'a'.repeat(64),
} as const

function buildWorkerReport(
  input: Parameters<typeof buildWorkerReportProduction>[0],
): WorkerReport {
  return buildWorkerReportProduction({
    ...input,
    policyEpoch: input.policyEpoch ?? STABLE_POLICY_IDENTITY.policyEpoch,
    policyDigest: input.policyDigest ?? STABLE_POLICY_IDENTITY.policyDigest,
  })
}

function candidate(overrides: Partial<WorkerReport> = {}): WorkerReport {
  const report = {
    schema_version: 'worker-report/1',
    task_id: 'worker-task',
    run_id: 'worker-run',
    worker_id: 'worker-id',
    model: 'gpt-5.6-luna',
    effort_used: 'medium',
    policy_epoch: 7,
    policy_digest: 'a'.repeat(64),
    status: 'completed',
    summary: 'Implemented the requested change and verified it.',
    changed_files: ['src/worker.ts'],
    evidence: [
      {
        id: 'test-1',
        type: 'test',
        command: 'bun test src/worker.test.ts',
        exit_code: 0,
      },
    ],
    tokens_used: 999,
    validation: { verdict: 'pass' },
    blockers: [],
    ...overrides,
  } as Omit<WorkerReport, 'report_id'> & Partial<Pick<WorkerReport, 'report_id'>>
  return {
    ...report,
    report_id:
      overrides.report_id ??
      deriveWorkerReportId(report.task_id, report.run_id, report.worker_id),
  }
}

describe('WorkerReport v1', () => {
  test('derives a golden report identity with unambiguous tuple framing', () => {
    expect(deriveWorkerReportId('task-1', 'run-2', 'worker-3')).toBe(
      '769838ab964b39dcc9bf8d98ed8e3c293a54841c1e42348f43cd775e05423e36',
    )
    expect(deriveWorkerReportId('ab', 'c', 'd')).not.toBe(
      deriveWorkerReportId('a', 'bc', 'd'),
    )
    const identity = deriveWorkerReportId('task', 'run', 'worker')
    expect(deriveWorkerReportId('task-2', 'run', 'worker')).not.toBe(identity)
    expect(deriveWorkerReportId('task', 'run-2', 'worker')).not.toBe(identity)
    expect(deriveWorkerReportId('task', 'run', 'worker-2')).not.toBe(identity)
  })

  test('reconstructs the same identity across success and failure', () => {
    const success = buildWorkerReport({
      taskId: 'same-task',
      runId: 'same-run',
      workerId: 'same-worker',
      status: 'completed',
      finalText: JSON.stringify(candidate()),
      tokensUsed: 2,
    })
    const failure = buildWorkerReport({
      taskId: 'same-task',
      runId: 'same-run',
      workerId: 'same-worker',
      status: 'failed',
      finalText: 'not-json',
      tokensUsed: 2,
    })
    expect(success.report_id).toBe(failure.report_id)
    expect(failure.report_id).toBe(
      deriveWorkerReportId('same-task', 'same-run', 'same-worker'),
    )
  })

  test('ignores a model-supplied report identity', () => {
    const report = buildWorkerReport({
      taskId: 'runtime-task',
      runId: 'runtime-run',
      workerId: 'runtime-worker',
      status: 'completed',
      finalText: JSON.stringify(
        candidate({ report_id: 'f'.repeat(64) }),
      ),
      tokensUsed: 1,
    })
    expect(report.report_id).toBe(
      deriveWorkerReportId('runtime-task', 'runtime-run', 'runtime-worker'),
    )
    expect(isWorkerReportCompletionEligible(report, STABLE_POLICY_IDENTITY)).toBe(true)
  })

  test('rejects missing and tampered report identities on the wire', () => {
    const valid = candidate()
    const { report_id: _missing, ...missing } = valid
    expect(workerReportSchema.safeParse(missing).success).toBe(false)
    expect(
      workerReportSchema.safeParse({
        ...valid,
        report_id: '0'.repeat(64),
      }).success,
    ).toBe(false)
    expect(
      isWorkerReportCompletionEligible(
        {
          ...valid,
          report_id: '0'.repeat(64),
        },
        STABLE_POLICY_IDENTITY,
      ),
    ).toBe(false)
  })

  test('rejects reports from a model other than the configured Worker model', () => {
    expect(
      workerReportSchema.safeParse(
        candidate({ model: 'unconfigured-provider-model' }),
      ).success,
    ).toBe(false)
  })

  test('emits the complete schema and owns runtime fields', () => {
    const report = buildWorkerReport({
      taskId: 'runtime-task',
      runId: 'runtime-run',
      workerId: 'runtime-worker',
      policyEpoch: 11,
      policyDigest: 'a'.repeat(64),
      status: 'completed',
      declaredChangedFiles: ['src/declared.ts'],
      finalText: JSON.stringify(
        candidate({
          task_id: 'forged-task',
          run_id: 'forged-run',
          worker_id: 'forged-worker',
          model: 'gpt-5.6-luna',
          effort_used: 'max',
          policy_epoch: 999,
          tokens_used: 1,
          changed_files: ['src/reported.ts'],
        }),
      ),
      tokensUsed: 321,
      effortUsed: 'low',
    })

    expect(report).toEqual({
      ...candidate({
        task_id: 'runtime-task',
        run_id: 'runtime-run',
        worker_id: 'runtime-worker',
        effort_used: 'low',
        policy_epoch: 11,
        policy_digest: report.policy_digest,
        tokens_used: 321,
        changed_files: ['src/declared.ts', 'src/reported.ts'],
      }),
    })
    expect(workerReportSchema.parse(report)).toEqual(report)
    expect(
      isWorkerReportCompletionEligible(report, {
        policyEpoch: 11,
        policyDigest: 'a'.repeat(64),
      }),
    ).toBe(true)
  })

  test('keeps the explicitly supplied policy identity on the runtime-owned report', () => {
    const report = buildWorkerReportProduction({
      taskId: 'explicit-policy',
      status: 'failed',
      tokensUsed: 0,
      policyEpoch: STABLE_POLICY_IDENTITY.policyEpoch,
      policyDigest: STABLE_POLICY_IDENTITY.policyDigest,
    })
    expect(report.policy_epoch).toBe(STABLE_POLICY_IDENTITY.policyEpoch)
    expect(report.policy_digest).toBe(STABLE_POLICY_IDENTITY.policyDigest)
  })

  test('keeps every exact Luna effort and defaults missing effort to medium', () => {
    for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const report = buildWorkerReport({
        taskId: `task-${effort}`,
        status: 'failed',
        effortUsed: effort,
        finalText: JSON.stringify(
          candidate({ status: 'failed', effort_used: effort, validation: { verdict: 'fail' }, blockers: ['failed'] }),
        ),
        tokensUsed: 1,
      })
      expect(report.effort_used).toBe(effort)
    }

    const defaultReport = buildWorkerReport({
      taskId: 'default-effort',
      status: 'failed',
      finalText: JSON.stringify(
        candidate({ status: 'failed', validation: { verdict: 'fail' }, blockers: ['failed'] }),
      ),
      tokensUsed: 1,
    })
    expect(defaultReport.effort_used).toBe('medium')
  })

  test('rejects free-form output and never promotes it to successful evidence', () => {
    const transcript = 'PRIVATE FULL TRANSCRIPT WITH TOOL CALLS'
    const report = buildWorkerReport({
      taskId: 'invalid-task',
      runId: 'invalid-run',
      workerId: 'invalid-worker',
      status: 'completed',
      finalText: `${transcript}\nThe work is done.`,
      tokensUsed: 42,
      effortUsed: 'high',
    })

    expect(report.status).toBe('partial')
    expect(report.validation.verdict).toBe('fail')
    expect(report.evidence).toEqual([])
    expect(report.blockers).toContain('worker_report_invalid')
    expect(isWorkerReportCompletionEligible(report, STABLE_POLICY_IDENTITY)).toBe(false)
    expect(serializeWorkerReport(report)).not.toContain(transcript)
  })

  test('rejects JSON with prose and malformed string evidence', () => {
    const report = buildWorkerReport({
      taskId: 'malformed-task',
      status: 'completed',
      finalText: `${JSON.stringify(candidate())}\nextra prose`,
      tokensUsed: 8,
      effortUsed: 'medium',
    })
    expect(report.status).toBe('partial')

    const stringEvidence = buildWorkerReport({
      taskId: 'string-evidence',
      status: 'completed',
      finalText: JSON.stringify(candidate({ evidence: [] })),
      tokensUsed: 8,
      effortUsed: 'medium',
    })
    expect(stringEvidence.status).toBe('completed')
    expect(isWorkerReportCompletionEligible(stringEvidence, STABLE_POLICY_IDENTITY)).toBe(true)

    const invalidEvidence = buildWorkerReport({
      taskId: 'invalid-evidence',
      status: 'completed',
      finalText: JSON.stringify({
        ...candidate(),
        evidence: ['bun test passed'],
      }),
      tokensUsed: 8,
      effortUsed: 'medium',
    })
    expect(invalidEvidence.status).toBe('partial')
    expect(invalidEvidence.validation.verdict).toBe('fail')

    const absolutePath = buildWorkerReport({
      taskId: 'absolute-path',
      status: 'completed',
      finalText: JSON.stringify(
        candidate({ changed_files: ['/tmp/outside-workspace.ts'] }),
      ),
      tokensUsed: 8,
      effortUsed: 'medium',
    })
    expect(absolutePath.status).toBe('partial')
  })

  test('normalizes unknown fields from real Luna report responses', () => {
    const report = buildWorkerReport({
      taskId: 'luna-artifact',
      status: 'completed',
      finalText: JSON.stringify({
        ...candidate({
          evidence: [
            {
              id: 'check-1',
              type: 'artifact',
              calculation: '2+2=4',
              result: 4,
            } as WorkerReport['evidence'][number],
          ],
        }),
        calculation: '2+2=4',
        result: 4,
        conclusion: 'Verified',
        validation: { verdict: 'pass', details: '2+2=4' },
      }),
      tokensUsed: 24,
      effortUsed: 'medium',
    })

    expect(report.status).toBe('completed')
    expect(report.validation.verdict).toBe('pass')
    expect(report.evidence).toEqual([{ id: 'check-1', type: 'artifact' }])
    expect(report.evidence[0]).not.toHaveProperty('calculation')
    expect(report.evidence[0]).not.toHaveProperty('result')
    expect(report).not.toHaveProperty('calculation')
    expect(report).not.toHaveProperty('result')
    expect(report).not.toHaveProperty('conclusion')
    expect(report.validation).toEqual({ verdict: 'pass' })
  })

  test('serializes only schema fields and appends structured runtime evidence', () => {
    const report = buildWorkerReport({
      taskId: 'task-append',
      status: 'completed',
      finalText: JSON.stringify(candidate({ evidence: [] })),
      tokensUsed: 8,
      effortUsed: 'xhigh',
    })
    const appended = appendWorkerReportEvidence(report, 'runtime warning')
    expect(appended.evidence[0]).toMatchObject({ type: 'artifact' })
    expect(appended.evidence[0]).not.toHaveProperty('command')
    expect(JSON.parse(serializeWorkerReport(appended))).toEqual(appended)
    expect(buildWorkerReportInstruction('task-4', 'max')).toContain(
      'worker-report/1',
    )
    const instruction = buildWorkerReportInstruction('task-4', 'max')
    expect(instruction).toContain('report_id')
    expect(instruction).toContain('validation')
    for (const key of ['id', 'type', 'path', 'command', 'exit_code', 'digest']) {
      expect(instruction).toContain(key)
    }
  })

  test('requires validation pass and no blockers before completion', () => {
    const notRun = buildWorkerReport({
      taskId: 'not-run',
      status: 'completed',
      finalText: JSON.stringify(
        candidate({ validation: { verdict: 'not_run' } }),
      ),
      tokensUsed: 1,
      effortUsed: 'medium',
    })
    const blocked = buildWorkerReport({
      taskId: 'blocked',
      status: 'completed',
      finalText: JSON.stringify(
        candidate({ blockers: ['dependency pending'] }),
      ),
      tokensUsed: 1,
      effortUsed: 'medium',
    })
    expect(notRun.status).toBe('partial')
    expect(blocked.status).toBe('blocked')
    expect(isWorkerReportCompletionEligible(notRun, STABLE_POLICY_IDENTITY)).toBe(false)
    expect(isWorkerReportCompletionEligible(blocked, STABLE_POLICY_IDENTITY)).toBe(false)
  })
})
