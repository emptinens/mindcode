import { describe, expect, test } from "bun:test";
import { clearDeprecatedAccountCredentials } from "./clearDeprecatedAccountCredentials.js";
import type { SecureStorage, SecureStorageData } from "./types.js";

function fakeStorage(initial: SecureStorageData | null): SecureStorage & {
  data: SecureStorageData | null;
  deleteCalls: number;
  updateCalls: number;
} {
  return {
    name: "test",
    data: initial,
    deleteCalls: 0,
    updateCalls: 0,
    read() {
      return this.data;
    },
    async readAsync() {
      return this.data;
    },
    update(data) {
      this.updateCalls += 1;
      this.data = data;
      return { success: true };
    },
    delete() {
      this.deleteCalls += 1;
      this.data = null;
      return true;
    },
  };
}

describe("clearDeprecatedAccountCredentials", () => {
  test("preserves MCP OAuth while removing deprecated account fields", () => {
    const storage = fakeStorage({
      claudeAiOauth: {
        accessToken: "old",
        refreshToken: null,
        expiresAt: null,
        scopes: [],
        subscriptionType: null,
        rateLimitTier: null,
      },
      savedClaudeAccounts: {},
      mcpOAuth: { math: { accessToken: "keep" } },
    });

    expect(clearDeprecatedAccountCredentials(storage)).toBe(true);
    expect(storage.data).toEqual({
      mcpOAuth: { math: { accessToken: "keep" } },
    });
    expect(storage.updateCalls).toBe(1);
    expect(storage.deleteCalls).toBe(0);
  });

  test("deletes storage only when deprecated credentials are all it contains", () => {
    const storage = fakeStorage({ savedClaudeAccounts: {} });
    expect(clearDeprecatedAccountCredentials(storage)).toBe(true);
    expect(storage.data).toBeNull();
    expect(storage.deleteCalls).toBe(1);
  });

  test("does not rewrite unrelated storage", () => {
    const storage = fakeStorage({ mcpOAuth: { ida: { token: "keep" } } });
    expect(clearDeprecatedAccountCredentials(storage)).toBe(true);
    expect(storage.updateCalls).toBe(0);
    expect(storage.deleteCalls).toBe(0);
  });
});
