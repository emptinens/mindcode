import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./REPL.tsx', import.meta.url), 'utf8')
  .split('\n//# sourceMappingURL=', 1)[0]
const footerSource = readFileSync(
  new URL('../components/PromptInput/PromptInputFooter.tsx', import.meta.url),
  'utf8',
)
const indicatorsSource = readFileSync(
  new URL('../components/PromptInput/PromptInputStatusIndicators.tsx', import.meta.url),
  'utf8',
)

test('active queries always render processing status outside compact mode', () => {
  expect(source).toContain('|| !!userInputOnProcessing) && (')
  expect(source).toContain(
    'isLoading || queryGuard.isActive || userInputOnProcessing',
  )
  expect(source).toContain('setUserInputOnProcessing(input)')
  expect(source).toContain(
    'isLoading={isLoading || queryGuard.isActive || userInputOnProcessing !== undefined}',
  )
  expect(source).toContain(
    '{showSpinner && compactStartTime === null && <SpinnerWithVerb',
  )
  expect(footerSource).toContain(
    '<PromptInputStatusIndicators messages={messages} isLoading={isLoading}',
  )
  expect(indicatorsSource).toContain(
    "if (isWorking) parts.push({ text: 'Working…' })",
  )
  expect(source).toContain(
    'settleWithFallback(getSystemPrompt(',
  )
  expect(source).toContain('settleWithFallback(getUserContext(), {}, 3000)')
  expect(source).toContain('settleWithFallback(getSystemContext(), {}, 3000)')
})
