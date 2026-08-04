import React, { useState } from 'react'
import type { DeepImmutable } from 'src/types/utils.js'
import type { CommandResultDisplay } from '../../commands.js'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type {
  LocalWorkflowTaskState,
  WorkflowAgentState,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'

type Props = {
  workflow: DeepImmutable<LocalWorkflowTaskState>
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  onBack?: () => void
  onKill?: () => void
  onSkipAgent?: (agentId: string) => void
  onRetryAgent?: (agentId: string) => void
}

const STATE_COLOR: Record<WorkflowAgentState['state'], string> = {
  queued: 'gray',
  running: 'background',
  done: 'success',
  error: 'error',
  skipped: 'warning',
}

const VISIBLE_LOGS = 8

export function WorkflowDetailDialog({
  workflow,
  onDone,
  onBack,
  onKill,
  onSkipAgent,
  onRetryAgent,
}: Props): React.ReactNode {
  const elapsed = useElapsedTime(
    workflow.startTime,
    workflow.status === 'running',
    1000,
    0,
  )
  const [selected, setSelected] = useState(0)
  const agents = workflow.agents ?? []
  const running = agents.filter(a => a.state === 'running').length
  const done = agents.filter(a => a.state === 'done').length

  useKeybindings({ 'confirm:yes': () => onDone() }, { context: 'Confirmation' })

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'left' && onBack) {
      e.preventDefault()
      onBack()
    } else if (e.key === 'x' && workflow.status === 'running' && onKill) {
      e.preventDefault()
      onKill()
    } else if ((e.key === 'down' || e.key === 'j') && agents.length > 0) {
      e.preventDefault()
      setSelected(i => Math.min(agents.length - 1, i + 1))
    } else if ((e.key === 'up' || e.key === 'k') && agents.length > 0) {
      e.preventDefault()
      setSelected(i => Math.max(0, i - 1))
    } else if (e.key === 's' && onSkipAgent && agents[selected]) {
      e.preventDefault()
      onSkipAgent(agents[selected]!.agentId)
    } else if (e.key === 'r' && onRetryAgent && agents[selected]) {
      e.preventDefault()
      onRetryAgent(agents[selected]!.agentId)
    }
  }

  const tokens = workflow.totalTokens ?? 0
  const subtitle = (
    <Text dimColor>
      {elapsed} · {agents.length} {agents.length === 1 ? 'agent' : 'agents'}
      {running > 0 ? ` · ${running} running` : ''}
      {done > 0 ? ` · ${done} done` : ''}
      {tokens > 0 ? ` · ${tokens} tokens` : ''}
    </Text>
  )

  const recentLogs = (workflow.logs ?? []).slice(-VISIBLE_LOGS)

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title={`Workflow: ${workflow.workflowName ?? workflow.description}`}
        subtitle={subtitle}
        onCancel={() => onDone()}
        color="background"
        inputGuide={() => (
          <Byline>
            {onBack && <KeyboardShortcutHint shortcut="←" action="go back" />}
            <KeyboardShortcutHint shortcut="Esc" action="close" />
            {agents.length > 0 && (
              <KeyboardShortcutHint shortcut="↑/↓" action="select agent" />
            )}
            {workflow.status === 'running' && onSkipAgent && (
              <KeyboardShortcutHint shortcut="s" action="skip" />
            )}
            {workflow.status === 'running' && onRetryAgent && (
              <KeyboardShortcutHint shortcut="r" action="retry" />
            )}
            {workflow.status === 'running' && onKill && (
              <KeyboardShortcutHint shortcut="x" action="stop" />
            )}
          </Byline>
        )}
      >
        <Box flexDirection="column" gap={1}>
          <Text>
            <Text bold>Status:</Text>{' '}
            {workflow.status === 'running' ? (
              <Text color="background">running</Text>
            ) : workflow.status === 'completed' ? (
              <Text color="success">completed</Text>
            ) : (
              <Text color="error">{workflow.status}</Text>
            )}
          </Text>

          {agents.length === 0 ? (
            <Text dimColor>
              {workflow.status === 'running' ? 'Starting…' : '(no agents)'}
            </Text>
          ) : (
            <Box flexDirection="column">
              {agents.map((a, i) => (
                <Text key={a.agentId}>
                  <Text color={i === selected ? 'background' : undefined}>
                    {i === selected ? '❯ ' : '  '}
                  </Text>
                  <Text color={STATE_COLOR[a.state]}>{a.state.padEnd(7)}</Text>
                  {'  '}
                  {a.phaseTitle ? `[${a.phaseTitle}] ` : ''}
                  {a.label}
                  {a.tokens ? <Text dimColor> · {a.tokens} tok</Text> : null}
                </Text>
              ))}
            </Box>
          )}

          {recentLogs.length > 0 && (
            <Box flexDirection="column">
              <Text bold>Log:</Text>
              {recentLogs.map((l, i) => (
                <Text key={i} dimColor wrap="truncate-end">
                  {'  '}
                  {l}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      </Dialog>
    </Box>
  )
}
