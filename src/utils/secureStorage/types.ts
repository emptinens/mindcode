export type OAuthTokenData = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  scopes: string[]
  subscriptionType: string | null
  rateLimitTier: string | null
}

export type SecureStorageData = {
  claudeAiOauth?: OAuthTokenData
  savedClaudeAccounts?: Record<string, OAuthTokenData>
  mcpOAuth?: Record<string, Record<string, unknown>>
}

export type SecureStorage = {
  name: string
  read(): SecureStorageData | null
  readAsync(): Promise<SecureStorageData | null>
  update(data: SecureStorageData): { success: boolean; warning?: string }
  delete(): boolean
}
