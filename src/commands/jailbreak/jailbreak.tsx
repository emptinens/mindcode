import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  type JailbreakLevel,
  getJailbreakLevel,
  setJailbreakLevel,
} from '../../utils/jailbreak.js'
import { Select } from '../../components/CustomSelect/index.js'
import { Pane } from '../../components/design-system/Pane.js'
import { Byline } from '../../components/design-system/Byline.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'

const LEVELS: { value: JailbreakLevel; label: string; description: string }[] =
  [
    {
      value: 'disabled',
      label: 'Disabled',
      description: 'No content-handling overrides or synthetic history',
    },
    {
      value: 'lowered',
      label: 'Lowered',
      description:
        'Softer content-handling section, no synthetic history (default)',
    },
    {
      value: 'full',
      label: 'Full',
      description:
        'Strongest content-handling section + full synthetic history priming',
    },
  ]

function JailbreakPicker({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const setAppState = useSetAppState()
  const exitState = useExitOnCtrlCDWithKeybindings()
  const current = getJailbreakLevel()

  const options = LEVELS.map(l => ({
    label: `${l.label}${l.value === current ? ' (current)' : ''}`,
    value: l.value,
    description: l.description,
  }))

  const handleSelect = (value: JailbreakLevel) => {
    setJailbreakLevel(value)
    setAppState(prev => ({ ...prev, jailbreakLevel: value }))
    onDone(`Jailbreak level set to ${value}`, { display: 'local-only' })
  }

  const handleCancel = () => {
    onDone(`Kept jailbreak level as ${current}`, { display: 'local-only' })
  }

  const content = (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text color="remember" bold>
          Select jailbreak level
        </Text>
        <Text dimColor>
          Controls the content-handling system prompt section and synthetic
          history priming. Applies to this session.
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="column">
          <Select
            defaultValue={current}
            defaultFocusValue={current}
            options={options}
            onChange={handleSelect}
            onCancel={handleCancel}
          />
        </Box>
      </Box>

      <Text dimColor italic>
        {exitState.pending ? (
          <>Press {exitState.keyName} again to exit</>
        ) : (
          <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="confirm" />
            <ConfigurableShortcutHint
              action="select:cancel"
              context="Select"
              fallback="Esc"
              description="exit"
            />
          </Byline>
        )}
      </Text>
    </Box>
  )

  return <Pane color="permission">{content}</Pane>
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode> {
  const trimmed = args?.trim().toLowerCase() || ''

  if (trimmed === 'disabled' || trimmed === 'lowered' || trimmed === 'full') {
    const level = trimmed as JailbreakLevel
    setJailbreakLevel(level)
    return <ApplyAndClose level={level} onDone={onDone} />
  }

  if (trimmed && trimmed !== '') {
    onDone(
      `Invalid argument: ${args}. Valid options are: disabled, lowered, full`,
      { display: 'local-only' },
    )
    return
  }

  return <JailbreakPicker onDone={onDone} />
}

function ApplyAndClose({
  level,
  onDone,
}: {
  level: JailbreakLevel
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const setAppState = useSetAppState()
  React.useEffect(() => {
    setAppState(prev => ({ ...prev, jailbreakLevel: level }))
    onDone(`Jailbreak level set to ${level}`, { display: 'local-only' })
  }, [setAppState, level, onDone])
  return null
}
