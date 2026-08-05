import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const uiFiles = [
  'main.tsx',
  'components/Onboarding.tsx',
  'components/HelpV2/HelpV2.tsx',
  'components/VexzyApiKeySetup.tsx',
  'components/ModelPicker.tsx',
  'components/WorkflowMultiselectDialog.tsx',
  'components/permissions/PermissionRequest.tsx',
  'components/permissions/PermissionPrompt.tsx',
  'components/permissions/EnterPlanModePermissionRequest/EnterPlanModePermissionRequest.tsx',
  'components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx',
  'components/messages/UserToolResultMessage/RejectedPlanMessage.tsx',
  'components/FeedbackSurvey/TranscriptSharePrompt.tsx',
  'components/FeedbackSurvey/FeedbackSurveyView.tsx',
  'components/sandbox/SandboxOverridesTab.tsx',
  'components/sandbox/SandboxDependenciesTab.tsx',
  'components/sandbox/SandboxSettings.tsx',
  'components/TrustDialog/TrustDialog.tsx',
  'components/CostThresholdDialog.tsx',
  'components/AutoModeOptInDialog.tsx',
  'components/BypassPermissionsModeDialog.tsx',
  'components/HelpV2/General.tsx',
  'components/hooks/SelectEventMode.tsx',
  'components/hooks/SelectMatcherMode.tsx',
  'components/hooks/SelectHookMode.tsx',
  'components/hooks/HooksConfigMenu.tsx',
  'components/hooks/ViewHookMode.tsx',
  'components/Spinner.tsx',
]

function readUiSource(relativePath: string): string {
  const source = readFileSync(resolve(root, relativePath), 'utf8')
  return source
    .split('\n//# sourceMappingURL=', 1)[0]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

test('runtime UI uses MindCode and VEXZY branding', () => {
  const source = uiFiles.filter(path => path !== 'main.tsx').map(readUiSource).join('\n')
  const legacyUiPhrases = [
    'Claude in Chrome',
    'Claude subscription',
    'Claude can make mistakes',
    'Claude needs your',
    'Claude wants to',
    'tell Claude',
    'Claude Desktop',
    'Claude account',
    'Anthropic account',
    'Anthropic Console',
    'Claude Pro/Max',
    'Hello, Claude!',
  ]

  for (const phrase of legacyUiPhrases) {
    expect(source).not.toContain(phrase)
  }
})

test('help, model, and setup-token labels are MindCode/VEXZY branded', () => {
  const main = readUiSource('main.tsx')
  const auth = readUiSource('components/VexzyApiKeySetup.tsx')

  expect(main).toContain('gpt-5.6-terra')
  expect(main).toContain('requires a VEXZY API key')
  expect(main).toContain('Verify VEXZY_API_KEY authentication')
  expect(auth).toContain('MindCode uses VEXZY_API_KEY for API access.')
  expect(auth).toContain('export VEXZY_API_KEY=&quot;forge-...&quot;')
  expect(auth).not.toContain('OAuth')
  expect(readUiSource('components/ApproveApiKey.tsx')).toContain('VEXZY_API_KEY')
})
