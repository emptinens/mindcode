import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { getMindCodeConfigHomeDir } from '../utils/envUtils.js'
import {
  CLI_NAME,
  CONFIG_DIRECTORY_NAME,
  CONFIG_ENVIRONMENT_VARIABLE,
  ENVIRONMENT_PREFIX,
  INSTRUCTIONS_FILE_NAME,
  PACKAGE_NAME,
  PRODUCT_NAME,
} from './identity.js'

describe('MindCode identity', () => {
  test('uses one public product namespace', () => {
    expect({
      product: PRODUCT_NAME,
      cli: CLI_NAME,
      package: PACKAGE_NAME,
      configDirectory: CONFIG_DIRECTORY_NAME,
      configEnvironmentVariable: CONFIG_ENVIRONMENT_VARIABLE,
      instructionsFile: INSTRUCTIONS_FILE_NAME,
      environmentPrefix: ENVIRONMENT_PREFIX,
    }).toEqual({
      product: 'MindCode',
      cli: 'mindcode',
      package: 'mindcode',
      configDirectory: '.mindcode',
      configEnvironmentVariable: 'MINDCODE_CONFIG_DIR',
      instructionsFile: 'MINDCODE.md',
      environmentPrefix: 'MINDCODE_',
    })
  })

  test('honors the MindCode config override', () => {
    const previous = process.env.MINDCODE_CONFIG_DIR
    const override = join(process.cwd(), '.test-mindcode-config')

    try {
      process.env.MINDCODE_CONFIG_DIR = override
      expect(getMindCodeConfigHomeDir()).toBe(override.normalize('NFC'))
    } finally {
      if (previous === undefined) process.env.MINDCODE_CONFIG_DIR = undefined
      else process.env.MINDCODE_CONFIG_DIR = previous
    }
  })
})
