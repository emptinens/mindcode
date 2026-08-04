import * as React from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  runExtraUsage,
  submitExtraUsageAdminRequest,
} from './extra-usage-core.js'

type PendingAdminRequest = {
  extraUsageAlreadyEnabled: boolean
}

function UsageCreditsFlow({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const [pending, setPending] =
    React.useState<PendingAdminRequest | null>(null)

  React.useEffect(() => {
    let active = true
    void runExtraUsage().then(result => {
      if (!active) return
      if (result.type === 'message') {
        onDone(result.value)
        return
      }
      if (result.type === 'browser-opened') {
        onDone(
          result.opened
            ? `Browser opened to manage usage credits. If it didn't open, visit: ${result.url}`
            : `Please visit ${result.url} to manage usage credits.`,
        )
        return
      }
      setPending({
        extraUsageAlreadyEnabled: result.extraUsageAlreadyEnabled,
      })
    })
    return () => {
      active = false
    }
  }, [onDone])

  if (!pending) return null

  const action = pending.extraUsageAlreadyEnabled ? 'increase' : 'enable'
  return (
    <Dialog
      title="Request usage credits?"
      subtitle="This will notify your organization admin."
      color="warning"
      onCancel={() => onDone('Usage credit request cancelled.')}
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          Send a request to {action} usage credits for your account?
        </Text>
        <Select
          options={[
            { label: 'Yes, notify my admin', value: 'yes' },
            { label: 'No, cancel', value: 'no' },
          ]}
          onChange={value => {
            if (value !== 'yes') {
              onDone('Usage credit request cancelled.')
              return
            }
            void submitExtraUsageAdminRequest(
              pending.extraUsageAlreadyEnabled,
            ).then(result => {
              if (result.type === 'message') onDone(result.value)
            })
          }}
        />
      </Box>
    </Dialog>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
): Promise<React.ReactNode> {
  return <UsageCreditsFlow onDone={onDone} />
}
