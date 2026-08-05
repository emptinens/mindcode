import {
  VEXZY_API_KEY_ENV,
  assertVexzyApiKey,
  requireVexzyApiKey,
} from "../services/api/vexzy/config.js";

/**
 * VEXZY-only authentication facade.
 *
 * The module keeps the historical export surface used by older consumers, but
 * the only credential source is VEXZY_API_KEY. Compatibility functions that
 * represented other providers deliberately return neutral values.
 */

export type ApiKeySource = string;
export type SubscriptionType = string;

export type AccountInfo = {
  accountUuid?: string;
  emailAddress?: string;
  organizationUuid?: string;
  organizationName?: string | null;
  organizationRole?: string | null;
  workspaceRole?: string | null;
  displayName?: string;
  hasExtraUsageEnabled?: boolean;
  billingType?: string | null;
};

export type UserAccountInfo = {
  subscription?: string;
  tokenSource?: string;
  apiKeySource?: ApiKeySource;
  organization?: string;
  email?: string;
};

export type CompatibilityTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes: readonly string[];
  subscriptionType: SubscriptionType | null;
  rateLimitTier: string | null;
};

export type OrgValidationResult =
  | { valid: true }
  | { valid: false; message: string };

type ApiKeyResult = {
  key: string | null;
  source: ApiKeySource;
};

function readVexzyApiKey(): string | undefined {
  if (process.env[VEXZY_API_KEY_ENV] === undefined) return undefined;
  return requireVexzyApiKey();
}

function readVexzyApiKeyResult(): ApiKeyResult {
  const key = readVexzyApiKey();
  return key ? { key, source: "VEXZY_API_KEY" } : { key: null, source: "none" };
}

export function isAnthropicAuthEnabled(): boolean {
  readVexzyApiKey();
  return false;
}

export function getAuthTokenSource(): {
  source: ApiKeySource;
  hasToken: boolean;
} {
  const key = readVexzyApiKey();
  return {
    source: key ? "VEXZY_API_KEY" : "none",
    hasToken: key !== undefined,
  };
}

export function getAnthropicApiKey(): string | null {
  return readVexzyApiKey() ?? null;
}

export function hasAnthropicApiKeyAuth(): boolean {
  return readVexzyApiKey() !== undefined;
}

export function getAnthropicApiKeyWithSource(
  _opts: { skipRetrievingKeyFromApiKeyHelper?: boolean } = {},
): ApiKeyResult {
  return readVexzyApiKeyResult();
}

export function getConfiguredApiKeyHelper(): undefined {
  return undefined;
}

export function isAwsAuthRefreshFromProjectSettings(): boolean {
  return false;
}

export function isAwsCredentialExportFromProjectSettings(): boolean {
  return false;
}

export function calculateApiKeyHelperTTL(): number {
  return 0;
}

export function getApiKeyHelperElapsedMs(): number {
  return 0;
}

export async function getApiKeyFromApiKeyHelper(
  _isNonInteractiveSession: boolean,
): Promise<null> {
  return null;
}

export function getApiKeyFromApiKeyHelperCached(): null {
  return null;
}

export function clearApiKeyHelperCache(): void {}

export function prefetchApiKeyFromApiKeyHelperIfSafe(
  _isNonInteractiveSession: boolean,
): void {}

type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
};

export function refreshAwsAuth(_awsAuthRefresh: string): Promise<boolean> {
  return Promise.resolve(false);
}

export const refreshAndGetAwsCredentials =
  async (): Promise<AwsCredentials | null> => null;

export function clearAwsCredentialsCache(): void {}

export function isGcpAuthRefreshFromProjectSettings(): boolean {
  return false;
}

export async function checkGcpCredentialsValid(): Promise<boolean> {
  return false;
}

export function refreshGcpAuth(_gcpAuthRefresh: string): Promise<boolean> {
  return Promise.resolve(false);
}

export const refreshGcpCredentialsIfNeeded = async (): Promise<boolean> =>
  false;

export function clearGcpCredentialsCache(): void {}

export function prefetchGcpCredentialsIfSafe(): void {}

export function prefetchAwsCredentialsAndBedRockInfoIfSafe(): void {}

export function getApiKeyFromConfigOrMacOSKeychain(): ApiKeyResult | null {
  const result = readVexzyApiKeyResult();
  return result.key ? result : null;
}

export async function saveApiKey(apiKey: string): Promise<void> {
  assertVexzyApiKey(apiKey);
  process.env[VEXZY_API_KEY_ENV] = apiKey;
}

export function isCustomApiKeyApproved(apiKey: string): boolean {
  assertVexzyApiKey(apiKey);
  return readVexzyApiKey() === apiKey;
}

export async function removeApiKey(): Promise<void> {
  Reflect.deleteProperty(process.env, VEXZY_API_KEY_ENV);
}

export function saveOAuthTokensIfNeeded(_tokens: unknown): {
  success: boolean;
  warning?: string;
} {
  return { success: true };
}

export function getClaudeAIOAuthTokens(): CompatibilityTokens | null {
  return null;
}

export function clearOAuthTokenCache(): void {}


/** @deprecated Provider token expiry is not applicable to VEXZY API keys. */
export function isOAuthTokenExpired(_expiresAt: number | null): boolean {
  return false
}

export function handleOAuth401Error(
  _failedAccessToken: string,
): Promise<boolean> {
  return Promise.resolve(false);
}

export async function getClaudeAIOAuthTokensAsync(): Promise<CompatibilityTokens | null> {
  return null;
}

export function checkAndRefreshOAuthTokenIfNeeded(
  _retryCount = 0,
  _force = false,
): Promise<boolean> {
  return Promise.resolve(false);
}

export function isClaudeAISubscriber(): boolean {
  return false;
}

export function hasProfileScope(): boolean {
  return false;
}

export function is1PApiCustomer(): boolean {
  return false;
}

export function getOauthAccountInfo(): AccountInfo | undefined {
  return undefined;
}

/** Compatibility no-op for removed provider organization lookups. */
export async function getOrganizationUUID(): Promise<null> {
  return null;
}

export function isOverageProvisioningAllowed(): boolean {
  return false;
}

export function hasOpusAccess(): boolean {
  return false;
}

export function getSubscriptionType(): SubscriptionType | null {
  return null;
}

export function isMaxSubscriber(): boolean {
  return false;
}

export function isTeamSubscriber(): boolean {
  return false;
}

export function isTeamPremiumSubscriber(): boolean {
  return false;
}

export function isEnterpriseSubscriber(): boolean {
  return false;
}

export function isProSubscriber(): boolean {
  return false;
}

export function getRateLimitTier(): string | null {
  return null;
}

export function getSubscriptionName(): string {
  return "";
}

export function isUsing3PServices(): boolean {
  return false;
}

export function isOtelHeadersHelperFromProjectOrLocalSettings(): boolean {
  return false;
}

export function getOtelHeadersFromHelper(): Record<string, string> {
  return {};
}

export function isConsumerSubscriber(): boolean {
  return false;
}

export function getAccountInformation(): UserAccountInfo | undefined {
  return undefined;
}

export async function validateForceLoginOrg(): Promise<OrgValidationResult> {
  return { valid: true };
}
