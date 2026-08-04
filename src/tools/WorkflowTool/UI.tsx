import * as React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import { Box, Text } from '../../ink.js'
import type { ProgressMessage } from '../../types/message.js'
import type { AgentState } from './vm.js'

// Structural progress payload emitted via onProgress while the workflow runs.
// (Progress types are type-erased at build time, so this is the source of truth.)
export type WorkflowAgentSnapshot = {
  index: number
  label: string
  phaseTitle?: string
  state: AgentState
  tokens?: number
}

export type WorkflowProgressData = {
  type: 'workflow_progress'
  workflowName: string
  startTime: number
  agents: WorkflowAgentSnapshot[]
  logs: string[]
}

// Valid theme color per state; `queued` renders dim (no accent color).
const STATE_COLOR: Partial<Record<AgentState, string>> = {
  running: 'background',
  done: 'success',
  error: 'error',
  skipped: 'warning',
}

const MAX_AGENTS_SHOWN = 14

export function renderToolUseMessage(
  input: { name?: string; scriptPath?: string } | undefined,
): React.ReactNode {
  // The framework already prefixes the tool name as "Workflow(<this>)", so
  // return just the label to avoid a doubled "Workflow(Workflow(...))".
  return <Text>{input?.name ?? 'dynamic workflow'}</Text>
}

function isWorkflowProgress(d: unknown): d is WorkflowProgressData {
  return (
    typeof d === 'object' &&
    d !== null &&
    (d as { type?: unknown }).type === 'workflow_progress'
  )
}

// Stateful so the elapsed timer ticks every second on its own, independent of
// when new progress events arrive (otherwise time/age looks frozen between
// agent state changes).
function WorkflowProgressView({
  data,
}: {
  data: WorkflowProgressData
}): React.ReactNode {
  const agents = data.agents
  const running = agents.filter(a => a.state === 'running').length
  const done = agents.filter(a => a.state === 'done').length
  const failed = agents.filter(a => a.state === 'error').length
  const totalTokens = agents.reduce((s, a) => s + (a.tokens ?? 0), 0)
  // Ticks every 1s while mounted (the progress view only mounts while running).
  const elapsed = useElapsedTime(data.startTime, true, 1000, 0)

  const shown = agents.slice(-MAX_AGENTS_SHOWN)
  const hidden = agents.length - shown.length
  const lastLog = data.logs.at(-1)

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text>
          <Text bold>Workflow:</Text> {data.workflowName}{' '}
          <Text dimColor>
            · {elapsed} · {agents.length}{' '}
            {agents.length === 1 ? 'agent' : 'agents'}
            {running > 0 ? ` · ${running} running` : ''}
            {done > 0 ? ` · ${done} done` : ''}
            {failed > 0 ? ` · ${failed} failed` : ''}
            {totalTokens > 0 ? ` · ${totalTokens} tok` : ''}
          </Text>
        </Text>
        {hidden > 0 && (
          <Text dimColor>
            {'  '}({hidden} earlier {hidden === 1 ? 'agent' : 'agents'})
          </Text>
        )}
        {shown.map(a => (
          <Text key={a.index} wrap="truncate-end">
            {'  '}
            {STATE_COLOR[a.state] ? (
              <Text color={STATE_COLOR[a.state]}>{a.state.padEnd(7)}</Text>
            ) : (
              <Text dimColor>{a.state.padEnd(7)}</Text>
            )}
            {'  '}
            {a.phaseTitle ? <Text dimColor>[{a.phaseTitle}] </Text> : null}
            {a.label}
            {a.tokens ? <Text dimColor> · {a.tokens} tok</Text> : null}
          </Text>
        ))}
        {lastLog && (
          <Text dimColor wrap="truncate-end">
            {'  '}
            {lastLog}
          </Text>
        )}
      </Box>
    </MessageResponse>
  )
}

export function renderToolUseProgressMessage(
  progressMessages: ProgressMessage<WorkflowProgressData>[],
): React.ReactNode {
  const last = progressMessages.at(-1)
  if (!last || !isWorkflowProgress(last.data)) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>Starting workflow…</Text>
      </MessageResponse>
    )
  }
  return <WorkflowProgressView data={last.data} />
}

type WorkflowResultOutput = {
  status: 'async_launched' | 'completed' | 'failed'
  workflowName?: string
  agentCount?: number
  totalTokens?: number
  error?: string
}

export function renderToolResultMessage(
  content: WorkflowResultOutput,
): React.ReactNode {
  if (content.status === 'failed') {
    return (
      <MessageResponse height={1}>
        <Text color="error">
          Workflow failed{content.error ? `: ${content.error}` : ''}
        </Text>
      </MessageResponse>
    )
  }
  const parts: string[] = []
  if (content.agentCount)
    parts.push(`${content.agentCount} ${content.agentCount === 1 ? 'agent' : 'agents'}`)
  if (content.totalTokens) parts.push(`${content.totalTokens} tokens`)
  return (
    <MessageResponse height={1}>
      <Text>
        <Text color="success">✓</Text> Workflow {content.workflowName ?? ''}{' '}
        completed
        {parts.length > 0 ? <Text dimColor> · {parts.join(' · ')}</Text> : null}
      </Text>
    </MessageResponse>
  )
}
