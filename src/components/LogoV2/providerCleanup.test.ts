import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const read = (file: string) => readFileSync(resolve(root, file), 'utf8')

test('startup keeps the VEXZY catalog bootstrap without provider prefetches', () => {
  const source = read('main.tsx')
  expect(source).toContain('await fetchBootstrapData()')
  expect(source).not.toContain('prefetchPassesEligibility')
  expect(source).not.toContain('prefetchFastModeStatus')
  expect(source).not.toContain('resolveFastModeStatusFromCache')
})

test('LogoV2 keeps Sakura and local status surfaces without provider upsells', () => {
  const source = read('components/LogoV2/LogoV2.tsx')
  expect(source).toContain('AnimatedSakura')
  expect(source).toContain('createRecentActivityFeed')
  expect(source).toContain('createWhatsNewFeed')
  expect(source).toContain('RuntimeIndicators')
  expect(source).not.toContain('GuestPassesUpsell')
  expect(source).not.toContain('OverageCreditUpsell')
  expect(source).not.toContain('Opus1mMergeNotice')
  expect(source).not.toContain('VoiceModeNotice')
  expect(source).not.toContain('ChannelsNotice')
})
