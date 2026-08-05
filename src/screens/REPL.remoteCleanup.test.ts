import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./REPL.tsx', import.meta.url), 'utf8')
  .split('\n//# sourceMappingURL=', 1)[0]

const removedRuntimePaths = [
  'useReplBridge',
  'replBridgePermissionCallbacks',
  'showRemoteCallout',
  'RemoteCallout',
  'useRemoteSession',
  'useAssistantHistory',
  'AntModelSwitchCallout',
  'UndercoverAutoCallout',
  'model-switch',
  'undercover-callout',
  'remote-callout',
]

test('active REPL does not mount legacy provider remote or callout paths', () => {
  for (const path of removedRuntimePaths) {
    expect(source).not.toContain(path)
  }
})

test('local team, MCP, and IDE integrations remain wired', () => {
  expect(source).toContain('useSwarmInitialization')
  expect(source).toContain('useMailboxBridge')
  expect(source).toContain('MCPConnectionManager')
  expect(source).toContain('useIdeLogging')
  expect(source).toContain('useIdeSelection')
})
