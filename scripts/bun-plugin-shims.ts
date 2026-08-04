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
  name: 'claude-code-shims',
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
          /^(?:@ant\/|@anthropic-ai\/(?:bedrock-sdk|foundry-sdk|vertex-sdk|mcpb|sandbox-runtime)$|audio-capture-napi$|modifiers-napi$|sharp$)/,
      },
      args => ({
        path: args.path,
        namespace:
          args.path === '@anthropic-ai/sandbox-runtime'
            ? 'sandbox-runtime-shim'
            : args.path === '@ant/claude-for-chrome-mcp'
              ? 'chrome-mcp-shim'
              : 'missing-package',
      }),
    )

    build.onLoad({ filter: /.*/, namespace: 'sandbox-runtime-shim' }, () => ({
      loader: 'js',
      contents: `
export class SandboxViolationStore {
  getRecentViolations() { return [] }
  getViolationCount() { return 0 }
  getTotalCount() { return 0 }
  subscribe(_cb) { return () => {} }
  clear() {}
}

const emptyStore = new SandboxViolationStore()

export const SandboxRuntimeConfigSchema = {
  parse(value) { return value },
  safeParse(value) { return { success: true, data: value } },
}

export const SandboxManager = {
  checkDependencies() { return { errors: [], warnings: [] } },
  isSupportedPlatform() { return false },
  async initialize() {},
  updateConfig() {},
  async reset() {},
  getFsReadConfig() { return { allowed: [], denied: [] } },
  getFsWriteConfig() { return { allowOnly: [], denyWithinAllow: [] } },
  getNetworkRestrictionConfig() { return { allowed: [], denied: [] } },
  getIgnoreViolations() { return undefined },
  getAllowUnixSockets() { return undefined },
  getAllowLocalBinding() { return undefined },
  getEnableWeakerNestedSandbox() { return undefined },
  getProxyPort() { return undefined },
  getSocksProxyPort() { return undefined },
  getLinuxHttpSocketPath() { return undefined },
  getLinuxSocksSocketPath() { return undefined },
  async waitForNetworkInitialization() { return false },
  getSandboxViolationStore() { return emptyStore },
  annotateStderrWithSandboxFailures(_command, stderr) { return stderr },
  cleanupAfterCommand() {},
  async wrapWithSandbox(command) { return command },
}
`,
    }))

    build.onLoad({ filter: /.*/, namespace: 'chrome-mcp-shim' }, () => ({
      loader: 'js',
      contents: `
export const BROWSER_TOOLS = []
export function createClaudeForChromeMcpServer() {
  return { async connect() {} }
}
export default { BROWSER_TOOLS, createClaudeForChromeMcpServer }
`,
    }))

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
