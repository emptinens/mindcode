import type React from 'react'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text, useInput } from '../../ink.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

function VexzyLoginNotice({ onDone }: { onDone: () => void }): React.ReactNode {
  useInput((_input, key) => {
    if (key.escape || key.return) onDone()
  })

  return (
    <Dialog
      title="VEXZY API access"
      onCancel={onDone}
      color="permission"
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="close"
          />
        )
      }
    >
      <Box flexDirection="column" gap={1}>
        <Text>MindCode uses VEXZY API credentials.</Text>
        <Text>Set VEXZY_API_KEY before starting MindCode:</Text>
        <Text color="success">{'export VEXZY_API_KEY="forge-…"'}</Text>
        <Text dimColor>Press Enter or Esc to close.</Text>
      </Box>
    </Dialog>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return <VexzyLoginNotice onDone={() => onDone('VEXZY_API_KEY setup unchanged')} />
}
