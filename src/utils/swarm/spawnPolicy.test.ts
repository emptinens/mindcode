import { describe, expect, test } from 'bun:test'
import {
  allocateUniqueTeammateName,
  buildSwarmTmuxArgs,
  upsertMemberByAgentId,
} from './spawnPolicy.js'

describe('swarm spawn policy', () => {
  test('always addresses the PID-isolated swarm socket', () => {
    expect(buildSwarmTmuxArgs('claude-swarm-42', ['new-window'])).toEqual([
      '-L',
      'claude-swarm-42',
      'new-window',
    ])
  })

  test('allocates unique names across roster and reservations', () => {
    expect(
      allocateUniqueTeammateName('worker', [
        'worker',
        'worker-2',
        'WORKER-3',
      ]),
    ).toBe('worker-4')
  })

  test('merges a member without dropping parallel roster entries', () => {
    expect(
      upsertMemberByAgentId(
        [
          { agentId: 'a', name: 'alpha' },
          { agentId: 'b', name: 'beta' },
        ],
        { agentId: 'b', name: 'beta-updated' },
      ),
    ).toEqual([
      { agentId: 'a', name: 'alpha' },
      { agentId: 'b', name: 'beta-updated' },
    ])
  })
})
