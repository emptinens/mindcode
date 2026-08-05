import type { SecureStorage, SecureStorageData } from "./types.js";

/**
 * Remove deprecated account credentials without deleting MCP OAuth state or
 * any future secure-storage fields owned by unrelated features.
 */
export function clearDeprecatedAccountCredentials(
  storage: SecureStorage,
): boolean {
  const current = storage.read();
  if (current === null) return true;

  const {
    claudeAiOauth: _deprecatedOauth,
    savedClaudeAccounts: _deprecatedAccounts,
    ...preserved
  } = current;

  if (_deprecatedOauth === undefined && _deprecatedAccounts === undefined) {
    return true;
  }

  if (Object.keys(preserved).length === 0) {
    return storage.delete();
  }

  return storage.update(preserved as SecureStorageData).success;
}
