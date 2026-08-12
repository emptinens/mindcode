#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, statSync, readFileSync, writeFileSync as writeFileBytes } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import esbuild from 'esbuild'
import { stripBareCommonJsEnvironmentProbes } from './bun-esm-compat.mjs'
import { packageNativeDaemon, selectBunTargets } from './native-daemon.mjs'
import { nativeTuiTargetForBun, packageNativeTui } from './native-tui.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outdir = path.join(root, 'dist')
const srcAliasPlugin = {
  name: 'src-alias',
  setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (args.resolveDir.includes(`${path.sep}node_modules${path.sep}`)) return
      if (!args.path.startsWith('src/') && !args.path.startsWith('.')) return

      const basePath = args.path.startsWith('src/')
        ? path.join(root, args.path)
        : path.resolve(args.resolveDir, args.path)

      const resolved = resolveSourcePath(basePath)
      return resolved
        ? { path: resolved }
        : {
            path: args.path,
            namespace: 'missing-local',
            pluginData: { request: args.path },
          }
    })

    build.onLoad({ filter: /.*/, namespace: 'missing-local' }, args => {
      const request = args.pluginData?.request ?? args.path
      if (String(request).endsWith('.md')) {
        return { loader: 'js', contents: 'export default ""' }
      }
      return {
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
      }
    })
  },
}

function resolveSourcePath(candidate) {
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
  return candidates.find(file => existsSync(file) && statSync(file).isFile())
}

// bun --compile bakes the entry file's absolute path into the standalone binary
// as `var __filename = "<build-root>/scripts/.tmp/mindcode.js"`, injected AFTER
// the mindcode.js path-stripping pass, so the build machine's home dir leaks into
// every shipped executable. No bun flag disables this. Scrub it out of the
// finished binary by overwriting the build-root prefix wherever it appears with
// an equal-length filler, preserving every byte offset so the binary stays
// valid. Derived from `root` at build time, so it works on any machine/OS.
//
// After scrubbing, fail loud: re-scan for the build machine's home dir and
// throw if it survives. This scrub only strips the path forms it knows; a
// future bun version that embeds the path in a new form (UTF-16, file:// URL,
// split bytes) would slip past it. The guard turns that silent regression into
// an immediate, obvious build failure instead of shipping a binary that leaks
// the build machine's path.
function scrubBuildPath(binaryPath) {
  const buf = readFileSync(binaryPath)
  // Scrub both the project root AND the home dir. Native addons embedded by
  // bun --compile (e.g. ssh2's sshcrypto.node) carry node-gyp build paths that
  // live under the home dir on a different branch than the project root, so
  // scrubbing root alone leaves the username exposed.
  const bases = [root, os.homedir()]
  // Each base can appear JS-escaped (Windows: C:\\Users\\..), raw, or with
  // forward slashes...
  const forms = new Set()
  for (const base of bases) {
    if (!base) continue
    forms.add(base)
    forms.add(base.replace(/\\/g, '\\\\'))
    forms.add(base.replace(/\\/g, '/'))
  }
  let hits = 0
  for (const form of forms) {
    // ...and in either latin1 (bundled JS, ELF/Mach-O strings) or utf16le
    // (Windows native-addon debug strings). The guard below checks both
    // encodings, so the scrub must cover both too.
    for (const enc of ['latin1', 'utf16le']) {
      const needle = Buffer.from(form, enc)
      if (needle.length === 0) continue
      let idx = buf.indexOf(needle)
      while (idx !== -1) {
        // Equal-length filler keeps the byte offset of everything after it intact.
        Buffer.from('.'.repeat(needle.length), 'latin1').copy(buf, idx)
        hits++
        idx = buf.indexOf(needle, idx + needle.length)
      }
    }
  }
  if (hits > 0) writeFileBytes(binaryPath, buf)

  // Fail-loud guard: the build machine's home directory (which contains the
  // username — the actually-sensitive part of the path) must not survive in any
  // encoding. Checking the home dir rather than the project name avoids false
  // positives, since "mindcode" legitimately appears throughout the binary
  // (package name, URLs, plugin prefixes) unrelated to the build path.
  const homeDir = os.homedir()
  const scrubbed = readFileSync(binaryPath)
  for (const form of [homeDir, homeDir.replace(/\\/g, '\\\\'), homeDir.replace(/\\/g, '/')]) {
    for (const enc of ['latin1', 'utf16le']) {
      if (scrubbed.indexOf(Buffer.from(form, enc)) !== -1) {
        throw new Error(
          `scrubBuildPath: home-dir marker "${form}" (${enc}) still present in ` +
            `${path.basename(binaryPath)} after scrubbing. bun likely changed how it ` +
            `embeds the entry path; update scrubBuildPath to cover the new form.`,
        )
      }
    }
  }
  return hits
}

const bunBundleShimPlugin = {
  name: 'bun-bundle-shim',
  setup(build) {
    build.onResolve({ filter: /^bun:bundle$/ }, () => ({
      path: 'bun:bundle',
      namespace: 'bun-bundle-shim',
    }))
    build.onLoad({ filter: /.*/, namespace: 'bun-bundle-shim' }, () => ({
      loader: 'js',
      // WORKFLOW_SCRIPTS is enabled in this build to ship dynamic workflows /
      // ultracode. All other build flags remain off.
      contents:
        'export function feature(name) { return name === "WORKFLOW_SCRIPTS" }',
    }))
  },
}

const nativeShimPlugin = {
  name: 'native-shims',
  setup(build) {
    build.onResolve({ filter: /^color-diff-napi$/ }, () => ({
      path: path.join(root, 'src/native-ts/color-diff/index.ts'),
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
    build.onLoad({ filter: /.*/, namespace: 'missing-package' }, () => ({
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
}

export function canonicalizeWreqLoader(source, fileToEmbed = null) {
  let canonical = source
    .replace(/\bnativeRequire\("\.\.\/rust\//g, 'require("../rust/')
    .replace(/\brequire\("\.\.\/rust\//g, 'nativeRequire("../rust/')
  if (fileToEmbed) {
    canonical = canonical.replace(
      `nativeRequire("../rust/${fileToEmbed}")`,
      `require("../rust/${fileToEmbed}")`,
    )
  }
  return canonical
}

export async function withCanonicalWreqLoader({ loaderPath, fileToEmbed = null, run }) {
  if (!existsSync(loaderPath)) return run()
  const original = await readFile(loaderPath, 'utf8')
  try {
    await writeFile(loaderPath, canonicalizeWreqLoader(original, fileToEmbed))
    return await run()
  } finally {
    await writeFile(loaderPath, original)
  }
}

export async function build({ minify = false, watch = false } = {}) {
  await mkdir(outdir, { recursive: true })

// Ensure dist is treated as ESM by bun/node
await writeFile(
  path.join(outdir, 'package.json'),
  JSON.stringify({ name: 'mindcode', version: '0.1.2', type: 'module' }, null, 2) + '\n',
)

const options = {
  entryPoints: [path.join(root, 'src/entrypoints/cli.tsx')],
  outfile: path.join(outdir, 'mindcode.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  jsx: 'automatic',
  minify,
  sourcemap: false,
  banner: {
    js: `#!/usr/bin/env bun
import { createRequire as __createRequire } from "node:module";
const require = __createRequire(import.meta.url);
const MACRO = {
  VERSION: "0.1.2",
  BUILD_TIME: ${JSON.stringify(new Date().toISOString())},
  ISSUES_EXPLAINER: "file an issue in the MindCode repository",
  VERSION_CHANGELOG: ""
};`,
  },
  define: {
    'MACRO.VERSION': JSON.stringify('0.1.2'),
    'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
  },
  external: [
    'bun:sqlite',
    'node-pty',
    'bun-pty',
    'ssh2',
    'cpu-features',
    'fsevents',
    'wreq-js',
    '@aws-sdk/*',
    '@smithy/*',
    '@azure/identity',
    'google-auth-library',
  ],
  loader: {
    '.md': 'text',
  },
  plugins: [bunBundleShimPlugin, nativeShimPlugin, srcAliasPlugin],
  logLevel: 'info',
}

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
  console.log('watching...')
} else {
  await esbuild.build(options)

  // Strip absolute paths from the output to avoid leaking personal info
  const outfile = path.join(outdir, 'mindcode.js')
  let code = await readFile(outfile, 'utf8')

  // Replace any absolute path pointing to the project root with ./
  const rootEscaped = root.replace(/[/\\]+/g, '[/\\\\]+')
  code = code.replace(new RegExp(rootEscaped + '[/\\\\]?', 'g'), './')
  // Also catch Windows-style paths with backslashes in strings
  const rootWin = root.replace(/\//g, '\\\\')
  const rootWinEscaped = rootWin.replace(/[\\]/g, '\\\\')
  code = code.replace(new RegExp(rootWinEscaped + '\\\\?', 'g'), './')

  // Fix bun's CJS detection: bun scans for bare `module` and `exports` tokens
  // and treats the file as CJS regardless of .mjs or package.json type.
  // These come from lodash/UMD environment detection which is dead code in ESM.
  // Remove complete lodash/UMD probes before replacing their `typeof` guards.
  // Production minification renames freeExports/freeModule and strips spaces,
  // so matching those source-level names is not reliable. Leaving the trailing
  // bare `exports` or `module` identifiers makes Bun classify this ESM bundle
  // as CommonJS and reject the banner's import statement.
  code = stripBareCommonJsEnvironmentProbes(code)
  code = code.replace(/typeof module !== "undefined"/g, 'typeof undefined !== "undefined"')
  code = code.replace(/typeof module2 !== "undefined"/g, 'typeof undefined !== "undefined"')
  // esbuild's __commonJS helper: rewrite to avoid bare `exports` token
  code = code.replace(
    /\(mod = \{ exports: \{\} \}\)\.exports, mod\), mod\.exports/g,
    '(mod = { ["ex"+"ports"]: {} })["ex"+"ports"], mod), mod["ex"+"ports"]'
  )
  // Also handle `module2.exports = factory2()` UMD patterns
  code = code.replace(/typeof exports2 === "object"/g, 'typeof undefined === "object"')

  await writeFile(outfile, code)
  console.log('Stripped absolute paths and fixed bun ESM detection.')

  // Compile to executables using bun --compile (cross-compilation)
  // Copy to a neutral path first so bun doesn't embed the user's home dir as __filename
  const tmpDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp', String(process.pid))
  await mkdir(tmpDir, { recursive: true })
  const tmpFile = path.join(tmpDir, 'mindcode.js')
  await writeFile(tmpFile, code)

  // wreq-js is intentionally NOT external here: bun embeds its .node addon into
  // the standalone exe. (It stays external for esbuild, which can't load .node.)
  const externals = [
    '--external', '@aws-sdk/*',
    '--external', '@smithy/*',
    '--external', '@azure/identity',
    '--external', 'google-auth-library',
    // node-pty stays external: it's only used under the Node runtime (dev). The
    // compiled binary runs on Bun, where spawnPty() takes the bun-pty branch, so
    // node-pty's require is never reached in the exe (and its .node can't be
    // embedded anyway).
    '--external', 'node-pty',
    // bun-pty and ssh2 are NOT external here: bun --compile must embed them (and
    // bun-pty's rust dll) into the standalone exe, since it has no node_modules
    // at runtime. They stay external for esbuild above, which can't parse
    // bun:ffi / load native addons.
    // cpu-features is an optional native dep of ssh2, guarded by try/catch;
    // leaving it external means ssh2 falls back to its pure-JS crypto in the exe.
    '--external', 'cpu-features',
    '--external', 'fsevents',
  ]

  // wreq-js loads its native .node addon through an aliased `nativeRequire`
  // (const nativeRequire = require). Bun's --compile embedder only traces
  // *literal* require("...node") calls, so the alias hides the addon and the
  // standalone binary fails with "Cannot find package 'wreq-js'" at runtime.
  //
  // The loader has one branch per platform, each requiring a different
  // ../rust/*.node. If we de-aliased them all, every target would embed all 7
  // addons (~56MB of dead weight). Instead we rewrite the loader per target:
  // de-alias ONLY the current target's .node (so bun embeds just it) and keep
  // the other branches aliased (so bun skips them). The map ties each bun
  // --compile target to the addon it should embed.
  const wreqLoader = path.join(root, 'node_modules/wreq-js/dist/wreq-js.cjs')
  const targetNodeFile = {
    'bun-windows-x64': 'wreq-js.win32-x64-msvc.node',
    'bun-linux-x64': 'wreq-js.linux-x64-gnu.node',
    'bun-linux-arm64': 'wreq-js.linux-arm64-gnu.node',
    'bun-darwin-x64': 'wreq-js.darwin-x64.node',
    'bun-darwin-arm64': 'wreq-js.darwin-arm64.node',
  }

  const targets = selectBunTargets()
  try {
    for (const target of targets) {
      const addon = targetNodeFile[target.bunTarget] ?? null
      await withCanonicalWreqLoader({
        loaderPath: wreqLoader,
        fileToEmbed: addon,
        run: async () => {
          if (addon) {
            console.log(`Embedding wreq-js addon ${addon} for ${target.bunTarget}`)
          }
          const dest = path.join(outdir, target.mindcodeName)
          execFileSync('bun', ['build', tmpFile, '--compile', `--target=${target.bunTarget}`, '--outfile', dest, ...externals], { stdio: 'inherit' })
          scrubBuildPath(dest)
          await packageNativeDaemon({ root, outdir, target, mindcodePath: dest })
          const tuiTarget = nativeTuiTargetForBun(target.bunTarget)
          if (tuiTarget) {
            await packageNativeTui({ root, outdir, target: tuiTarget })
          }
          console.log(`Compiled ${target.mindcodeName}`)
        },
      })
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

}


if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build({
    minify: process.argv.includes('--minify'),
    watch: process.argv.includes('--watch'),
  })
}
