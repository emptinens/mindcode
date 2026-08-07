import { VEXZY_MESSAGES_BASE_URL } from "../services/api/vexzy/config.js";

/**
 * Provider-neutral OAuth endpoint shape retained for old configuration callers.
 * VEXZY authentication uses an API key; no provider OAuth endpoints or scopes
 * are exposed by this module.
 */
export type OAuthConfig = {
  BASE_API_URL: string;
  MCP_PROXY_URL: string;
  MCP_PROXY_PATH: string;
};

const VEXZY_CONFIG: OAuthConfig = Object.freeze({
  BASE_API_URL: VEXZY_MESSAGES_BASE_URL,
  MCP_PROXY_URL: "",
  MCP_PROXY_PATH: "",
});

export function getOauthConfig(): OAuthConfig {
  return VEXZY_CONFIG;
}
