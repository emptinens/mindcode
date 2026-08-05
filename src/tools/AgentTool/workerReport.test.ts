import { describe, expect, test } from 'bun:test'
import {
  appendWorkerReportEvidence,
  buildWorkerReport,
  buildWorkerReportInstruction,
  isWorkerReportCompletionEligible,
  serializeWorkerReport,
  workerReportSchema,
  type WorkerReport,
} from './workerReport.js'

function candidate(overrides: Partial<WorkerReport> = {}): WorkerReport {
  return {
    schema_version: 'worker-report/1',
    task_id: 'worker-task',
    run_id: 'worker-run',
    worker_id: 'worker-id',
    model: 'gpt-5.6-luna',
    effort_used: 'medium',
    policy_epoch: 7,
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
  }
}

describe('WorkerReport v1', () => {
  test('emits the complete schema and owns runtime fields', () => {
    const report = buildWorkerReport({
      taskId: 'runtime-task',
      runId: 'runtime-run',
      workerId: 'runtime-worker',
      policyEpoch: 11,
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
        tokens_used: 321,
        changed_files: ['src/declared.ts', 'src/reported.ts'],
      }),
    })
    expect(workerReportSchema.parse(report)).toEqual(report)
    expect(isWorkerReportCompletionEligible(report)).toBe(true)
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
    expect(isWorkerReportCompletionEligible(report)).toBe(false)
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
    expect(isWorkerReportCompletionEligible(stringEvidence)).toBe(true)

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
    expect(buildWorkerReportInstruction('task-4', 'max')).toContain(
      'validation',
    )
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
    expect(isWorkerReportCompletionEligible(notRun)).toBe(false)
    expect(isWorkerReportCompletionEligible(blocked)).toBe(false)
  })
})
