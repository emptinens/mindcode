import { subprocessEnv } from "../../utils/subprocessEnv.js";

const INHERITED_STDIO_ENV = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
]);

/**
 * Build the SDK fallback environment with the same inheritance boundary as
 * the Rust supervisor. Credentials are accepted only when the user put them
 * explicitly in the MCP server configuration; ambient process credentials
 * never leak into an MCP child.
 */
export function getMcpSdkEnvironment(
  configured: Readonly<Record<string, string>> | undefined,
  inherited: Readonly<NodeJS.ProcessEnv> = subprocessEnv(),
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (
      typeof value !== "string" ||
      !isSafeInheritedKey(key) ||
      isForbiddenMindCodeCredentialKey(key)
    ) {
      continue;
    }
    environment[key] = value;
  }
  for (const [key, value] of Object.entries(configured ?? {})) {
    if (typeof value !== "string" || isForbiddenMindCodeCredentialKey(key)) {
      continue;
    }
    environment[key] = value;
  }
  return environment;
}

function isSafeInheritedKey(key: string): boolean {
  const upper = key.toUpperCase();
  return INHERITED_STDIO_ENV.has(upper) || upper.startsWith("LC_");
}

function isForbiddenMindCodeCredentialKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    upper === "AUTHORIZATION" ||
    upper.endsWith("_AUTHORIZATION") ||
    upper === "VEXZY_API_KEY" ||
    (upper.includes("VEXZY") &&
      /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|BEARER|COOKIE|PRIVATE|CERT)/.test(
        upper,
      ))
  );
}
