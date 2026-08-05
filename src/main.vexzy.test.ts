import { describe, expect, test } from 'bun:test'

const source = await Bun.file(new URL('./main.tsx', import.meta.url)).text()
const runtimeSource = source.split('//# sourceMappingURL=', 1)[0]

describe('main.tsx VEXZY-only startup regression', () => {
  test('removes legacy auth, provider, and remote activation paths', () => {
    for (const forbidden of [
      'prepareApiRequest',
      'getClaudeAIOAuthTokens',
      'checkAndRefreshOAuthTokenIfNeeded',
      'getOauthConfig',
      'getRemoteSessionUrl',
      'fetchClaudeAIMcpConfigsIfEligible',
      'checkQuotaStatus',
      'prefetchAwsCredentialsAndBedRockInfoIfSafe',
      'prefetchGcpCredentialsIfSafe',
      'createRemoteSessionConfig',
      'remoteSessionConfig',
      '_pendingAssistantChat',
      'remoteOption',
      'remoteControlOption',
      'teleport',
      "--remote'",
      "--teleport'",
      "--remote-control",
      "'--rc",
    ]) {
      expect(runtimeSource).not.toContain(forbidden)
    }
  })

  test('keeps local VEXZY session and provider-neutral capabilities', () => {
    for (const retained of [
      'process.env.MINDCODE_MODEL',
      "'--model <model>'",
      "'--agent-teams'",
      'runHeadless',
      'launchRepl',
      'getMindCodeMcpConfigs',
      'prefetchAllMcpResources',
    ]) {
      expect(runtimeSource).toContain(retained)
    }
  })
})
