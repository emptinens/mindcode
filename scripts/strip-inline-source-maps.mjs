import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])
const TRAILER_LINE = /(?:^|\r\n|\r|\n)([ \t]*\/\/# sourceMappingURL=data:[^\r\n]*)(?=(?:\r\n|\r|\n)?$)/u

export function stripInlineSourceMaps(source) {
  let result = source
  let trailers = 0
  let match

  while ((match = TRAILER_LINE.exec(result)) !== null) {
    result = result.slice(0, match.index) + result.slice(match.index + match[0].length)
    trailers++
  }

  return { source: result, trailers }
}

function sourceFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path)
  }
  return files
}

export function processDirectory(directory, { check = false } = {}) {
  const files = sourceFiles(directory)
  let changedFiles = 0
  let trailers = 0
  let bytesRemoved = 0

  for (const path of files) {
    const original = readFileSync(path, 'utf8')
    const cleaned = stripInlineSourceMaps(original)
    if (cleaned.trailers === 0) continue

    changedFiles++
    trailers += cleaned.trailers
    bytesRemoved += Buffer.byteLength(original) - Buffer.byteLength(cleaned.source)
    if (!check) writeFileSync(path, cleaned.source)
  }

  return { files: files.length, changedFiles, trailers, bytesRemoved }
}

function usage() {
  console.error(`Usage: ${basename(process.argv[1] ?? 'strip-inline-source-maps.mjs')} [--check] [directory]`)
  process.exitCode = 2
}

function main() {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const paths = args.filter(argument => argument !== '--check')
  if (paths.length > 1 || args.some(argument => argument !== '--check' && argument.startsWith('-'))) return usage()

  const directory = resolve(paths[0] ?? 'src')
  if (!statSync(directory).isDirectory()) return usage()
  const result = processDirectory(directory, { check })
  console.log(`${check ? 'Checked' : 'Processed'} ${result.files} files; ${result.changedFiles} changed; ${result.trailers} trailers; ${result.bytesRemoved} bytes ${check ? 'would be removed' : 'removed'}.`)
  if (check && result.trailers > 0) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
