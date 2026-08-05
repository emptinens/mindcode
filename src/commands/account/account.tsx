import type * as React from 'react'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text, useInput } from '../../ink.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { isVexzyApiKey } from '../../services/api/vexzy/config.js'

function VexzyAccount({ onDone }: { onDone: () => void }): React.ReactNode {
  useInput((_input, key) => {
    if (key.escape || key.return) onDone()
  })

  const configured = isVexzyApiKey(process.env.VEXZY_API_KEY)

  return (
    <Dialog
      title="VEXZY API"
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
        <Text>
          Status: {configured ? 'VEXZY_API_KEY configured' : 'not configured'}
        </Text>
        <Text>MindCode uses VEXZY API authentication only.</Text>
        {!configured && (
          <>
            <Text>Set the key before starting MindCode:</Text>
            <Text color="success">{'export VEXZY_API_KEY="forge-…"'}</Text>
          </>
        )}
        <Text dimColor>Press Enter or Esc to close.</Text>
      </Box>
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async onDone => (
  <VexzyAccount onDone={() => onDone('VEXZY_API_KEY status shown')} />
)
