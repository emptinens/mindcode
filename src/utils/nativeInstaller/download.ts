import type { ReleaseChannel } from "../config.js";

/**
 * Native self-updates are intentionally local-only in MindCode.
 *
 * The installer still exposes the old function-shaped API so callers fail at
 * the boundary with one deterministic diagnostic instead of attempting a
 * provider request or spawning a package-manager download.
 */
export const LOCAL_NATIVE_UPDATE_DISABLED_MESSAGE =
  "MindCode local build: native self-updates are disabled. Install the newer MindCode binary locally and restart the application.";

function throwLocalUpdateDisabled(): never {
  throw new Error(LOCAL_NATIVE_UPDATE_DISABLED_MESSAGE);
}

function normalizeDirectVersion(version: string): string | null {
  if (!/^v?\d+\.\d+\.\d+(-\S+)?$/.test(version)) {
    return null;
  }
  return version.startsWith("v") ? version.slice(1) : version;
}

/** Compatibility boundary: remote version checks are disabled. */
export async function getLatestVersionFromArtifactory(
  _tag = "latest",
): Promise<string> {
  return throwLocalUpdateDisabled();
}

/** Compatibility boundary: remote version checks are disabled. */
export async function getLatestVersionFromBinaryRepo(
  _channel: ReleaseChannel = "latest",
  _baseUrl = "",
  _authConfig?: { auth: { username: string; password: string } },
): Promise<string> {
  return throwLocalUpdateDisabled();
}

export async function getLatestVersion(
  channelOrVersion: string,
): Promise<string> {
  const directVersion = normalizeDirectVersion(channelOrVersion);
  if (directVersion) {
    return directVersion;
  }

  if (channelOrVersion !== "stable" && channelOrVersion !== "latest") {
    throw new Error(
      `Invalid channel: ${channelOrVersion}. Use 'stable' or 'latest'`,
    );
  }

  return throwLocalUpdateDisabled();
}

/** Compatibility boundary: package-manager downloads are disabled. */
export async function downloadVersionFromArtifactory(
  _version: string,
  _stagingPath: string,
): Promise<void> {
  throwLocalUpdateDisabled();
}

/** Compatibility boundary: binary downloads are disabled. */
export async function downloadVersionFromBinaryRepo(
  _version: string,
  _stagingPath: string,
  _baseUrl: string,
  _authConfig?: {
    auth?: { username: string; password: string };
    headers?: Record<string, string>;
  },
): Promise<void> {
  throwLocalUpdateDisabled();
}

export async function downloadVersion(
  _version: string,
  _stagingPath: string,
): Promise<"npm" | "binary"> {
  throwLocalUpdateDisabled();
}

/**
 * Kept as a stable test/export surface for downstream callers. There is no
 * download loop in the local-only implementation.
 */
export class StallTimeoutError extends Error {
  constructor() {
    super(LOCAL_NATIVE_UPDATE_DISABLED_MESSAGE);
    this.name = "StallTimeoutError";
  }
}

export const MAX_DOWNLOAD_RETRIES = 0;
export const STALL_TIMEOUT_MS = 0;

export const _downloadAndVerifyBinaryForTesting = async (
  ..._args: unknown[]
): Promise<void> => {
  throwLocalUpdateDisabled();
};
