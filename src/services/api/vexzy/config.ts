import { VexzyConfigurationError } from './errors.js'

export const VEXZY_API_KEY_ENV = 'VEXZY_API_KEY'

export const VEXZY_OPENAI_BASE_URL = 'https://api.echogate.one/v1'
export const VEXZY_MESSAGES_BASE_URL = 'https://api.echogate.one'

export const VEXZY_OPENAI_ENDPOINTS = Object.freeze({
  chatCompletions: `${VEXZY_OPENAI_BASE_URL}/chat/completions`,
  models: `${VEXZY_OPENAI_BASE_URL}/models`,
})

export const VEXZY_MESSAGES_ENDPOINT =
  `${VEXZY_MESSAGES_BASE_URL}/v1/messages`

export const VEXZY_ENDPOINTS = Object.freeze({
  ...VEXZY_OPENAI_ENDPOINTS,
  messages: VEXZY_MESSAGES_ENDPOINT,
})

export type VexzyEndpoints = typeof VEXZY_ENDPOINTS

export interface VexzyConfig {
  readonly apiKey: string
  readonly openAIBaseUrl: typeof VEXZY_OPENAI_BASE_URL
  readonly messagesBaseUrl: typeof VEXZY_MESSAGES_BASE_URL
  readonly endpoints: VexzyEndpoints
}

const VEXZY_API_KEY_PATTERN = /^forge-[^\s]+$/

export function isVexzyApiKey(value: unknown): value is string {
  return typeof value === 'string' && VEXZY_API_KEY_PATTERN.test(value)
}

export function assertVexzyApiKey(value: unknown): asserts value is string {
  if (!isVexzyApiKey(value)) {
    throw new VexzyConfigurationError()
  }
}

export function getVexzyApiKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = env[VEXZY_API_KEY_ENV]
  return isVexzyApiKey(value) ? value : undefined
}

export function requireVexzyApiKey(
  env: Record<string, string | undefined> = process.env,
): string {
  const value = env[VEXZY_API_KEY_ENV]
  assertVexzyApiKey(value)
  return value
}

export function createVexzyConfig(apiKey: string): VexzyConfig {
  assertVexzyApiKey(apiKey)
  return {
    apiKey,
    openAIBaseUrl: VEXZY_OPENAI_BASE_URL,
    messagesBaseUrl: VEXZY_MESSAGES_BASE_URL,
    endpoints: VEXZY_ENDPOINTS,
  }
}

export function getVexzyConfig(
  env: Record<string, string | undefined> = process.env,
): VexzyConfig {
  return createVexzyConfig(requireVexzyApiKey(env))
}
