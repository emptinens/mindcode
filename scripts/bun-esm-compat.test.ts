import { describe, expect, test } from 'bun:test'
import { stripBareCommonJsEnvironmentProbes } from './bun-esm-compat.mjs'

describe('stripBareCommonJsEnvironmentProbes', () => {
  test('removes production-minified lodash UMD probes', () => {
    const input =
      'a=typeof exports=="object"&&exports&&!exports.nodeType&&exports,' +
      'b=a&&typeof module=="object"&&module&&!module.nodeType&&module,' +
      'c=b&&b.exports===a'

    expect(stripBareCommonJsEnvironmentProbes(input)).toBe(
      'a=undefined,b=undefined,c=b&&b.exports===a',
    )
  })

  test('supports readable probes and strict equality guards', () => {
    const input =
      'freeExports = typeof exports === "object" && exports && ' +
      '!exports.nodeType && exports; freeModule = freeExports && ' +
      'typeof module === "object" && module && !module.nodeType && module;'

    const output = stripBareCommonJsEnvironmentProbes(input)
    expect(output).not.toMatch(/typeof\s+(?:exports|module)\b/)
    expect(output).not.toMatch(/(?:^|[^.\w$])(?:exports|module)(?:[^\w$]|$)/)
  })
})
