import { describe, expect, test } from 'bun:test'
import { filterWorkerTools } from './workerTools.js'

describe('worker tool policy', () => {
  test('removes worktree lifecycle tools and their aliases', () => {
    const tools = [
      { name: 'Read' },
      { name: 'EnterWorktree' },
      { name: 'ExitWorktree' },
      { name: 'WrappedEnter', aliases: ['EnterWorktree'] },
      { name: 'Bash' },
    ]

    expect(filterWorkerTools(tools).map(tool => tool.name)).toEqual([
      'Read',
      'Bash',
    ])
  })

  test('applies equally to exact fork tool arrays', () => {
    const parentTools = [
      { name: 'Read' },
      { name: 'EnterWorktree' },
      { name: 'ExitWorktree' },
    ] as const

    expect(filterWorkerTools(parentTools).map(tool => tool.name)).toEqual([
      'Read',
    ])
  })
})
