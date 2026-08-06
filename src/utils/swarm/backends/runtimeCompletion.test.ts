import { describe, expect, mock, test } from 'bun:test'
import type { WorkerReport } from '../../../tools/AgentTool/workerReport.js'
const agentSdkTypesMock = () => ({ HOOK_EVENTS: ['PreToolUse'] as const })
mock.module('src/entrypoints/agentSdkTypes.js', agentSdkTypesMock)
mock.module(
  new URL('../../../entrypoints/agentSdkTypes.ts', import.meta.url).pathname,
  agentSdkTypesMock,
)
mock.module('src/entrypoints/sdk/runtimeTypes.js', () => ({}))
mock.module(
  new URL('../../../entrypoints/sdk/runtimeTypes.ts', import.meta.url).pathname,
  () => ({}),
)

const { isWorkerReportFreshAndCorrelated, resolveWorkerReportTerminalStatus } =
  await import('../../../utils/teammateMailbox.js')
const {
  buildWorkerTeamReport,
  deriveWorkerReportId,
  isWorkerReportCompletionEligible,
} = await import('../workerTeamReport.js')
const { WORKER_EFFORT_LEVELS } = await import('./types.js')

function reportCandidate(overrides: Partial<WorkerReport> = {}): WorkerReport {
  const report = {
    schema_version: 'worker-report/1',
    task_id: 'runtime-task',
    run_id: 'runtime-run',
    worker_id: 'runtime-worker',
    model: 'gpt-5.6-luna',
    effort_used: 'medium',
    policy_epoch: 0,
    status: 'completed',
    summary: 'The worker completed the requested operation.',
    changed_files: [],
    evidence: [],
    tokens_used: 0,
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

function buildReport(
  status: WorkerReport['status'],
  finalText?: string,
): WorkerReport {
  return buildWorkerTeamReport({
    taskId: 'runtime-task',
    runId: 'runtime-run',
    workerId: 'runtime-worker',
    status,
    effortUsed: 'medium',
    changedFiles: [],
    evidence: [],
    tokensUsed: 0,
    finalText,
  })
}

describe('worker runtime completion gate', () => {
  const validReport = buildReport(
    'completed',
    JSON.stringify(reportCandidate()),
  )
  const invalidReport = buildReport('completed', 'unstructured worker output')
  const failedReport = buildReport('failed', 'unstructured worker output')
  const terminalCases = [
    ['missing', undefined, 'failed'],
    ['invalid', invalidReport, 'failed'],
    ['failed', failedReport, 'failed'],
    ['valid', validReport, 'completed'],
  ] as const

  test('valid reports are eligible and invalid reports fail closed', () => {
    expect(isWorkerReportCompletionEligible(validReport)).toBe(true)
    expect(isWorkerReportCompletionEligible(invalidReport)).toBe(false)
    expect(isWorkerReportCompletionEligible(failedReport)).toBe(false)
  })

  for (const [name, report, expected] of terminalCases) {
    test(`${name} in-process report maps to ${expected}`, () => {
      expect(resolveWorkerReportTerminalStatus(report)).toBe(expected)
    })
  }

  test('the report gate accepts every fixed Luna effort level', () => {
    for (const effort of WORKER_EFFORT_LEVELS) {
      const report = buildWorkerTeamReport({
        taskId: `runtime-${effort}`,
        runId: `run-${effort}`,
        workerId: 'runtime-worker',
        status: 'completed',
        effortUsed: effort,
        changedFiles: [],
        evidence: [],
        tokensUsed: 0,
        finalText: JSON.stringify(
          reportCandidate({
            task_id: `runtime-${effort}`,
            run_id: `run-${effort}`,
            effort_used: effort,
          }),
        ),
      })
      expect(report.effort_used).toBe(effort)
      expect(resolveWorkerReportTerminalStatus(report)).toBe('completed')
    }
  })

  test('crash or missing report cannot complete a pane task', () => {
    expect(resolveWorkerReportTerminalStatus(null)).toBe('failed')
    expect(resolveWorkerReportTerminalStatus(undefined)).toBe('failed')
    expect(resolveWorkerReportTerminalStatus(failedReport)).toBe('failed')
  })

  test('stale and mismatched reports fail lifecycle correlation closed', () => {
    const startedAtMs = Date.parse('2026-08-06T12:00:00.000Z')
    const expected = {
      workerId: 'runtime-worker',
      taskId: 'runtime-task',
      runId: 'runtime-run',
      startedAtMs,
    }
    const envelope = (report: WorkerReport, timestamp: string) => ({
      report,
      timestamp,
    })

    expect(
      isWorkerReportFreshAndCorrelated(
        envelope(validReport, '2026-08-06T12:00:01.000Z'),
        expected,
      ),
    ).toBe(true)
    for (const report of [
      { ...validReport, worker_id: 'other-worker' },
      { ...validReport, task_id: 'other-task' },
      { ...validReport, run_id: 'old-run' },
    ]) {
      expect(
        isWorkerReportFreshAndCorrelated(
          envelope(report, '2026-08-06T12:00:01.000Z'),
          expected,
        ),
      ).toBe(false)
    }
    expect(
      isWorkerReportFreshAndCorrelated(
        envelope(validReport, '2026-08-06T11:59:59.999Z'),
        expected,
      ),
    ).toBe(false)
    expect(
      isWorkerReportFreshAndCorrelated(
        envelope(validReport, 'not-a-timestamp'),
        expected,
      ),
    ).toBe(false)
  })

})
