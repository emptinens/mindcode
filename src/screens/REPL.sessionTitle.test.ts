import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./REPL.tsx', import.meta.url), 'utf8')
  .split('\n//# sourceMappingURL=', 1)[0] ?? ''

test('session title generation cannot delay the main query', () => {
  const queryStart = source.indexOf('for await (const event of query({')
  const titleStart = source.indexOf('void generateSessionTitle(')

  expect(queryStart).toBeGreaterThan(-1)
  expect(titleStart).toBeGreaterThan(queryStart)
  expect(source).toContain('AbortSignal.timeout(3000)')
})
