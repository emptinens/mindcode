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
      "global Worker model",
      "selected via /model",
      'runHeadless',
      'launchRepl',
      'getMindCodeMcpConfigs',
      'prefetchAllMcpResources',
      'leaderModelResolver.resolveSelectedModel(requestedModel)',
      'leaderModelResolver.resolveSelectedModel(fallbackModel)',
    ]) {
      expect(runtimeSource).toContain(retained)
    }
  })

  test('the --model help no longer advertises the removed /submodel command', () => {
    expect(runtimeSource).not.toContain('/submodel')
    expect(runtimeSource).not.toContain('Worker sessions are fixed')
  })

  test('does not invalidate the ready catalog with a redundant startup refresh', () => {
    expect(runtimeSource).toContain('await fetchBootstrapData()')
    expect(runtimeSource).not.toContain('refreshModelCapabilities')
  })
})
