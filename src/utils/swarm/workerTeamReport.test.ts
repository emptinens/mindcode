import { describe, expect, test } from 'bun:test'
import {
  findLatestWorkerReport,
  findLatestWorkerReportEnvelope,
  isIdleNotification,
} from '../teammateMailbox.js'
import {
  accumulateWorkerTokenUsage,
  buildWorkerTeamReport as buildWorkerTeamReportProduction,
  buildWorkerTeamReportFromMessages as buildWorkerTeamReportFromMessagesProduction,
  createWorkerTeamReportMessage,
  deriveWorkerReportId,
  serializeWorkerTeamReportMessage,
  workerTeamReportMessageSchema,
} from './workerTeamReport.js'
import type { WorkerReport } from '../../tools/AgentTool/workerReport.js'

const STABLE_POLICY_IDENTITY = {
  policyEpoch: 0,
  policyDigest: 'a'.repeat(64),
} as const

function buildWorkerTeamReport(
  input: Parameters<typeof buildWorkerTeamReportProduction>[0],
) {
  return buildWorkerTeamReportProduction({
    ...input,
    policyEpoch: input.policyEpoch ?? STABLE_POLICY_IDENTITY.policyEpoch,
    policyDigest: input.policyDigest ?? STABLE_POLICY_IDENTITY.policyDigest,
  })
}

function buildWorkerTeamReportFromMessages(
  input: Parameters<typeof buildWorkerTeamReportFromMessagesProduction>[0],
) {
  return buildWorkerTeamReportFromMessagesProduction({
    ...input,
    policyEpoch: input.policyEpoch ?? STABLE_POLICY_IDENTITY.policyEpoch,
    policyDigest: input.policyDigest ?? STABLE_POLICY_IDENTITY.policyDigest,
  })
}

type WorkerMessage = Parameters<
  typeof buildWorkerTeamReportFromMessages
>[0]['messages'][number]

function reportCandidate(overrides: Partial<WorkerReport> = {}): WorkerReport {
  const report = {
    schema_version: 'worker-report/1',
    task_id: 'candidate-task',
    run_id: 'candidate-run',
    worker_id: 'candidate-worker',
    model: 'gpt-5.6-luna',
    effort_used: 'medium',
    policy_epoch: 3,
    policy_digest: 'a'.repeat(64),
    status: 'completed',
    summary: 'Team worker completed the requested operation.',
    changed_files: ['src/team.ts'],
    evidence: [
      {
        id: 'team-test',
        type: 'test',
        command: 'bun test src/team.test.ts',
        exit_code: 0,
      },
    ],
    tokens_used: 100,
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

function assistantMessage(
  content: string,
  id: string,
  inputTokens = 10,
  outputTokens = 5,
  metadata?: {
    isApiErrorMessage?: boolean
    error?: string
    errorDetails?: string
  },
): WorkerMessage {
  return {
    type: 'assistant',
    uuid: `record-${id}`,
    requestId: id,
    isApiErrorMessage: metadata?.isApiErrorMessage,
    error: metadata?.error,
    errorDetails: metadata?.errorDetails,
    message: {
      id,
      model: 'gpt-5.6-luna',
      content: [{ type: 'text', text: content }],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as unknown as WorkerMessage
}

function userMessage(content: string): WorkerMessage {
  return {
    type: 'user',
    uuid: 'user-record',
    message: { content },
  } as unknown as WorkerMessage
}

describe('persistent teammate WorkerReport v1 transport', () => {
  test('success idle carries the complete schema-valid report', () => {
    const report = buildWorkerTeamReport({
      taskId: 'idle-success',
      runId: 'run-success',
      workerId: 'worker-a',
      policyEpoch: 8,
      status: 'completed',
      changedFiles: ['src/changed.ts'],
      tokensUsed: 42,
      effortUsed: 'high',
      finalText: JSON.stringify(
        reportCandidate({ changed_files: ['src/changed.ts'] }),
      ),
    })
    const message = createWorkerTeamReportMessage({
      from: 'worker-a',
      idleReason: 'available',
      report,
    })

    expect(workerTeamReportMessageSchema.parse(message).report).toMatchObject({
      schema_version: 'worker-report/1',
      task_id: 'idle-success',
      run_id: 'run-success',
      worker_id: 'worker-a',
      report_id: deriveWorkerReportId('idle-success', 'run-success', 'worker-a'),
      model: 'gpt-5.6-luna',
      effort_used: 'high',
      policy_epoch: 8,
      status: 'completed',
      changed_files: ['src/changed.ts'],
      tokens_used: 42,
      validation: { verdict: 'pass' },
      blockers: [],
    })
    expect(isIdleNotification(serializeWorkerTeamReportMessage(message))).toEqual(
      message,
    )
  })

  test('failure is schema-valid and runtime evidence is structured', () => {
    const message = createWorkerTeamReportMessage({
      from: 'worker-b',
      idleReason: 'failed',
      report: buildWorkerTeamReport({
        taskId: 'failed-task',
        runId: 'failed-run',
        workerId: 'worker-b',
        status: 'failed',
        evidence: ['API request failed'],
        tokensUsed: 7,
        effortUsed: 'medium',
      }),
    })

    expect(message.report.status).toBe('failed')
    expect(message.report.evidence[0]).toMatchObject({ type: 'artifact' })
    expect(message.report.validation.verdict).toBe('fail')
  })

  test('uses only the final assistant JSON and never serializes earlier transcript', () => {
    const earlierTranscript = 'EARLIER TRANSCRIPT MUST STAY PRIVATE'
    const messages = [
      userMessage('private prompt'),
      assistantMessage(earlierTranscript, 'response-earlier'),
      assistantMessage(
        JSON.stringify(
          reportCandidate({
            task_id: 'forged-task',
            status: 'failed',
            changed_files: ['src/final.ts'],
            validation: { verdict: 'pass' },
          }),
        ),
        'response-final',
      ),
    ]

    const report = buildWorkerTeamReportFromMessages({
      taskId: 'runtime-task',
      runId: 'runtime-run',
      workerId: 'runtime-worker',
      policyEpoch: 4,
      effortUsed: 'low',
      messages,
    })

    expect(report.status).toBe('failed')
    expect(report.task_id).toBe('runtime-task')
    expect(report.run_id).toBe('runtime-run')
    expect(report.worker_id).toBe('runtime-worker')
    expect(report.changed_files).toEqual(['src/final.ts'])
    expect(JSON.stringify(report)).not.toContain(earlierTranscript)
    expect(JSON.stringify(report)).not.toContain('private prompt')
  })

  test('free-form teammate output becomes partial with no free-form evidence', () => {
    const freeForm = `unstructured result ${'x'.repeat(4_000)}`
    const report = buildWorkerTeamReportFromMessages({
      taskId: 'pane-fallback',
      runId: 'pane-run',
      workerId: 'pane-worker',
      effortUsed: 'medium',
      messages: [assistantMessage(freeForm, 'pane-response')],
    })

    expect(report.status).toBe('partial')
    expect(report.changed_files).toEqual([])
    expect(report.evidence).toEqual([])
    expect(report.validation.verdict).toBe('fail')
    expect(JSON.stringify(report)).not.toContain('unstructured result')
  })

  test('API errors fail closed without transcript leakage', () => {
    const apiError = assistantMessage(
      'visible fallback text',
      'api-error-response',
      0,
      0,
      {
        isApiErrorMessage: true,
        errorDetails: 'gateway detail without error enum',
      },
    )
    const report = buildWorkerTeamReportFromMessages({
      taskId: 'api-error',
      runId: 'api-error-run',
      workerId: 'worker-api-error',
      effortUsed: 'xhigh',
      messages: [apiError],
    })

    expect(report.status).toBe('failed')
    expect(report.effort_used).toBe('xhigh')
    expect(report.evidence[0]).toMatchObject({ type: 'artifact' })
    expect(JSON.stringify(report)).not.toContain('gateway detail')
  })

  test('deduplicates usage for split assistant records sharing a response id', () => {
    const first = assistantMessage('part one', 'shared-response', 11, 7)
    const second = {
      ...assistantMessage('part two', 'shared-response', 11, 7),
      uuid: 'different-record-uuid',
    }
    const third = assistantMessage('next response', 'next-response', 3, 2)

    expect(accumulateWorkerTokenUsage([first, second, third])).toBe(23)
  })

  test('idle notification contains only validated WorkerReport JSON', () => {
    const transcript = 'FULL TRANSCRIPT: prompts, tool calls, and hidden output'
    const report = buildWorkerTeamReportFromMessages({
      taskId: 'idle-only',
      runId: 'idle-run',
      workerId: 'worker-c',
      effortUsed: 'none',
      messages: [
        userMessage(transcript),
        assistantMessage('older assistant secret', 'older-response'),
        assistantMessage(
          JSON.stringify(
            reportCandidate({
              task_id: 'runtime-task',
              changed_files: [],
              evidence: [],
            }),
          ),
          'final-response',
          0,
          0,
        ),
      ],
    })
    const message = createWorkerTeamReportMessage({
      from: 'worker-c',
      idleReason: 'available',
      report,
    })
    const serialized = serializeWorkerTeamReportMessage(message)

    expect(serialized).not.toContain(transcript)
    expect(serialized).not.toContain('summary:')
    expect(JSON.parse(serialized)).toEqual({
      type: 'idle_notification',
      from: 'worker-c',
      timestamp: expect.any(String),
      idleReason: 'available',
      report: {
        schema_version: 'worker-report/1',
        task_id: 'idle-only',
        run_id: 'idle-run',
        worker_id: 'worker-c',
        report_id: deriveWorkerReportId('idle-only', 'idle-run', 'worker-c'),
        model: 'gpt-5.6-luna',
        effort_used: 'none',
        policy_epoch: 0,
        policy_digest: expect.any(String),
        status: 'completed',
        summary: 'Team worker completed the requested operation.',
        changed_files: [],
        evidence: [],
        tokens_used: 15,
        validation: { verdict: 'pass' },
        blockers: [],
      },
    })
    expect(
      isIdleNotification(
        JSON.stringify({
          type: 'idle_notification',
          from: 'worker-c',
          timestamp: new Date().toISOString(),
          idleReason: 'available',
          summary: transcript,
        }),
      ),
    ).toBeNull()
  })

  test('latest report lookup ignores free-form and malformed mailbox entries', () => {
    const report = buildWorkerTeamReport({
      taskId: 'latest-report-task',
      runId: 'latest-report-run',
      workerId: 'worker-pane',
      status: 'completed',
      changedFiles: [],
      evidence: [],
      tokensUsed: 3,
      effortUsed: 'medium',
      finalText: JSON.stringify(
        reportCandidate({
          task_id: 'latest-report-task',
          run_id: 'latest-report-run',
          worker_id: 'worker-pane',
          changed_files: [],
          evidence: [],
          tokens_used: 3,
        }),
      ),
    })
    const notification = createWorkerTeamReportMessage({
      from: 'worker-pane',
      idleReason: 'available',
      report,
    })
    const messages = [
      {
        from: 'worker-pane',
        text: 'free-form output is not a report',
        timestamp: new Date().toISOString(),
        read: false,
      },
      {
        from: 'worker-pane',
        text: JSON.stringify({
          type: 'idle_notification',
          from: 'worker-pane',
          timestamp: new Date().toISOString(),
          idleReason: 'available',
        }),
        timestamp: new Date().toISOString(),
        read: false,
      },
      {
        from: 'worker-pane',
        text: serializeWorkerTeamReportMessage(notification),
        timestamp: new Date().toISOString(),
        read: false,
      },
    ]

    expect(findLatestWorkerReport(messages, 'worker-pane')).toEqual(report)
    expect(findLatestWorkerReport(messages.slice(0, 2), 'worker-pane')).toBeNull()
    expect(
      findLatestWorkerReport(
        [
          ...messages,
          {
            from: 'worker-pane',
            text: JSON.stringify({
              type: 'idle_notification',
              from: 'worker-pane',
              timestamp: new Date().toISOString(),
              idleReason: 'available',
            }),
            timestamp: new Date().toISOString(),
            read: false,
          },
        ],
        'worker-pane',
      ),
    ).toBeNull()
  })

  test('newer mismatched report wins transport lookup and cannot fall back', async () => {
    const report = buildWorkerTeamReport({
      taskId: 'current-task',
      runId: 'current-run',
      workerId: 'worker-pane',
      status: 'completed',
      changedFiles: [],
      evidence: [],
      tokensUsed: 1,
      effortUsed: 'medium',
      finalText: JSON.stringify(
        reportCandidate({
          task_id: 'current-task',
          run_id: 'current-run',
          worker_id: 'worker-pane',
          changed_files: [],
          evidence: [],
          tokens_used: 1,
        }),
      ),
    })
    const staleReport = {
      ...report,
      task_id: 'previous-task',
      report_id: deriveWorkerReportId(
        'previous-task',
        report.run_id,
        report.worker_id,
      ),
    }
    const currentMessage = createWorkerTeamReportMessage({
      from: 'worker-pane',
      idleReason: 'available',
      report,
    })
    const staleMessage = createWorkerTeamReportMessage({
      from: 'worker-pane',
      idleReason: 'available',
      report: staleReport,
    })
    const messages = [
      {
        from: 'worker-pane',
        text: serializeWorkerTeamReportMessage(currentMessage),
        timestamp: currentMessage.timestamp,
        read: false,
      },
      {
        from: 'worker-pane',
        text: serializeWorkerTeamReportMessage(staleMessage),
        timestamp: staleMessage.timestamp,
        read: false,
      },
    ]

    const snapshots = await Promise.all(
      Array.from({ length: 16 }, () =>
        Promise.resolve(
          findLatestWorkerReportEnvelope(messages, 'worker-pane'),
        ),
      ),
    )
    expect(snapshots.every(snapshot => snapshot?.report.task_id === 'previous-task')).toBe(true)
    expect(findLatestWorkerReport(messages, 'worker-pane')).toEqual(staleReport)
  })
})
