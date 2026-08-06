import { plugin } from 'bun'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dir, '..')

function resolveSourcePath(candidate: string): string | null {
  const candidates = [candidate]

  if (candidate.endsWith('.js')) {
    candidates.push(
      candidate.slice(0, -3) + '.ts',
      candidate.slice(0, -3) + '.tsx',
    )
  }

  if (!path.extname(candidate)) {
    candidates.push(
      candidate + '.ts',
      candidate + '.tsx',
      candidate + '.js',
      path.join(candidate, 'index.ts'),
      path.join(candidate, 'index.tsx'),
      path.join(candidate, 'index.js'),
    )
  }

  return (
    candidates.find(file => existsSync(file) && statSync(file).isFile()) ?? null
  )
}

plugin({
  name: 'mindcode-shims',
  setup(build) {
    build.onResolve({ filter: /^src\// }, args => {
      const basePath = path.join(root, args.path)
      const resolved = resolveSourcePath(basePath)
      if (resolved) {
        return { path: resolved }
      }
      return {
        path: args.path,
        namespace: 'missing-local',
      }
    })

    build.onResolve({ filter: /^bun:bundle$/ }, () => ({
      path: 'bun:bundle',
      namespace: 'bun-bundle-shim',
    }))

    build.onLoad({ filter: /.*/, namespace: 'bun-bundle-shim' }, () => ({
      loader: 'js',
      contents: 'export function feature() { return false }',
    }))

    build.onResolve(
      {
        filter:
          /^(?:audio-capture-napi$|modifiers-napi$|sharp$)/,
      },
      args => ({
        path: args.path,
        namespace: 'missing-package',
      }),
    )


    build.onLoad(
      { filter: /.*/, namespace: 'missing-package' },
      () => ({
        loader: 'js',
        contents: `
const noop = new Proxy(function () {}, {
  get: () => noop,
  apply: () => undefined,
  construct: () => ({})
})

module.exports = new Proxy({}, {
  get: (_target, prop) => prop === '__esModule' ? true : noop
})
`,
      }),
    )

    build.onLoad({ filter: /.*/, namespace: 'missing-local' }, () => ({
      loader: 'js',
      contents: `
const noop = new Proxy(function () {}, {
  get: () => noop,
  apply: () => undefined,
  construct: () => ({})
})

module.exports = new Proxy({}, {
  get: (_target, prop) => prop === '__esModule' ? true : noop
})
`,
    }))
  },
})
