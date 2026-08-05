import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const ownedProductionFiles = [
  'src/utils/managedEnv.ts',
  'src/utils/managedEnvConstants.ts',
  'src/utils/subprocessEnv.ts',
  'src/utils/swarm/spawnUtils.ts',
  'src/components/Settings/Config.tsx',
  'src/components/messages/AssistantTextMessage.tsx',
  'src/interactiveHelpers.tsx',
  'src/services/api/errors.ts',
  'src/services/api/logging.ts',
  'src/utils/status.tsx',
  'src/utils/envUtils.ts',
  'src/utils/statusNoticeDefinitions.tsx',
  'src/tools/BashTool/bashPermissions.ts',
]

const readSource = (file: string): string =>
  readFileSync(resolve(root, file), 'utf8').split('//# sourceMappingURL=', 1)[0] ?? ''

describe('VEXZY environment/runtime cleanup', () => {
  test('owned production files contain no legacy credential or provider env names', () => {
    const legacyCredentialNames = [
      ['ANTHROPIC', 'API_KEY'].join('_'),
      ['ANTHROPIC', 'BASE_URL'].join('_'),
      ['ANTHROPIC', 'AUTH_TOKEN'].join('_'),
    ]
    const legacyProviderEnv =
      /\b(?:ANTHROPIC|AWS|GOOGLE|AZURE|VERTEX|BEDROCK|FOUNDRY|CLOUD_ML)_[A-Z0-9_]+\b/

    for (const file of ownedProductionFiles) {
      const source = readSource(file)
      for (const name of legacyCredentialNames) {
        expect(source, `${file} contains ${name}`).not.toContain(name)
      }
      expect(source, `${file} contains a legacy provider env`).not.toMatch(
        legacyProviderEnv,
      )
    }
  })

  test('removes the old approval/conflict UI and endpoint metadata', () => {
    const config = readSource('src/components/Settings/Config.tsx')
    const interactive = readSource('src/interactiveHelpers.tsx')
    const notices = readSource('src/utils/statusNoticeDefinitions.tsx')
    const logging = readSource('src/services/api/logging.ts')
    const assistantErrors = readSource(
      'src/components/messages/AssistantTextMessage.tsx',
    )

    for (const source of [config, interactive, notices, assistantErrors]) {
      expect(source).not.toContain('ApproveApiKey')
      expect(source).not.toContain('customApiKeyResponses')
      expect(source).not.toContain('getCustomApiKeyStatus')
      expect(source).not.toContain('api-key-conflict')
      expect(source).not.toContain('INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL')
      expect(source).not.toContain('ORG_DISABLED_ERROR_MESSAGE_ENV_KEY')
    }
    expect(logging).not.toContain('baseUrl:')
    expect(logging).not.toContain('envSmallFastModel')
  })

  test('retains VEXZY credentials and MINDCODE runtime controls', () => {
    const spawn = readSource('src/utils/swarm/spawnUtils.ts')
    const subprocess = readSource('src/utils/subprocessEnv.ts')
    const constants = readSource('src/utils/managedEnvConstants.ts')

    expect(spawn).toContain('VEXZY_API_KEY')
    expect(subprocess).toContain('VEXZY_API_KEY')
    expect(constants).toContain('MINDCODE_MODEL')
    expect(constants).toContain('MINDCODE_EFFORT_LEVEL')
  })
})
