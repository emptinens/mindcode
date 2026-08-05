const IDENTIFIER = String.raw`[$A-Z_a-z][$\w]*`

const EXPORTS_PROBE = new RegExp(
  `(${IDENTIFIER})\\s*=\\s*typeof\\s+exports\\s*={2,3}\\s*["']object["']\\s*&&\\s*exports\\s*&&\\s*!exports\\.nodeType\\s*&&\\s*exports`,
  'g',
)

const MODULE_PROBE = new RegExp(
  `(${IDENTIFIER})\\s*=\\s*(${IDENTIFIER})\\s*&&\\s*typeof\\s+module\\s*={2,3}\\s*["']object["']\\s*&&\\s*module\\s*&&\\s*!module\\.nodeType\\s*&&\\s*module`,
  'g',
)

/**
 * Remove unbound CommonJS environment probes that make Bun misclassify an
 * esbuild ESM bundle as CommonJS. The patterns intentionally support both
 * readable and production-minified lodash/UMD output.
 */
export function stripBareCommonJsEnvironmentProbes(code) {
  return code
    .replace(EXPORTS_PROBE, '$1=undefined')
    .replace(MODULE_PROBE, '$1=undefined')
    .replace(
      /typeof\s+exports\s*==\s*"object"/g,
      'typeof undefined == "object"',
    )
    .replace(
      /typeof\s+exports\s*===\s*"object"/g,
      'typeof undefined === "object"',
    )
    .replace(
      /typeof\s+module\s*==\s*"object"/g,
      'typeof undefined == "object"',
    )
}
