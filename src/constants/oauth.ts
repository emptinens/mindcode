import { VEXZY_MESSAGES_BASE_URL } from '../services/api/vexzy/config.js'

/**
 * Provider OAuth was removed from the MindCode runtime. This narrow shape is
 * retained only for dormant compatibility modules that still build URLs from
 * the historical configuration accessor; it never contains credentials,
 * authorization endpoints, scopes, or provider metadata.
 */
export type OAuthCompatibilityConfig = {
  BASE_API_URL: string
  CONSOLE_AUTHORIZE_URL: string
  CLAUDE_AI_AUTHORIZE_URL: string
  CLAUDE_AI_ORIGIN: string
  TOKEN_URL: string
  API_KEY_URL: string
  ROLES_URL: string
  CONSOLE_SUCCESS_URL: string
  CLAUDEAI_SUCCESS_URL: string
  MANUAL_REDIRECT_URL: string
  CLIENT_ID: string
  OAUTH_FILE_SUFFIX: string
  MCP_PROXY_URL: string
  MCP_PROXY_PATH: string
}

const VEXZY_COMPATIBILITY_CONFIG: OAuthCompatibilityConfig = Object.freeze({
  BASE_API_URL: VEXZY_MESSAGES_BASE_URL,
  CONSOLE_AUTHORIZE_URL: '',
  CLAUDE_AI_AUTHORIZE_URL: '',
  CLAUDE_AI_ORIGIN: VEXZY_MESSAGES_BASE_URL,
  TOKEN_URL: '',
  API_KEY_URL: '',
  ROLES_URL: '',
  CONSOLE_SUCCESS_URL: '',
  CLAUDEAI_SUCCESS_URL: '',
  MANUAL_REDIRECT_URL: '',
  CLIENT_ID: '',
  OAUTH_FILE_SUFFIX: '',
  MCP_PROXY_URL: '',
  MCP_PROXY_PATH: '',
})

/** @deprecated Provider OAuth is disabled; use VEXZY API authentication. */
export function getOauthConfig(): OAuthCompatibilityConfig {
  return VEXZY_COMPATIBILITY_CONFIG
}

/** @deprecated OAuth scope metadata is unavailable in VEXZY mode. */
export const CLAUDE_AI_INFERENCE_SCOPE = '' as const
export const CLAUDE_AI_PROFILE_SCOPE = '' as const
export const OAUTH_BETA_HEADER = '' as const
