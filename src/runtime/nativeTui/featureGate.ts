export const NATIVE_TUI_ENV = "MINDCODE_NATIVE_TUI" as const;

export type NativeTuiMode = "auto" | "on" | "off";

export type NativeTuiDisableReason =
  | "explicit-off"
  | "unsupported-platform"
  | "stdin-not-tty"
  | "stdout-not-tty"
  | "insufficient-capability";

export type NativeTuiCapability = {
  /** Whether the terminal can render the native TUI. */
  nativeTui?: boolean;
};

export type NativeTuiFeatureGate = {
  enabled: boolean;
  mode: NativeTuiMode;
  requestedMode: NativeTuiMode;
  platform: string;
  platformSupported: boolean;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  capability: boolean;
  reason: "enabled" | NativeTuiDisableReason;
};

export type NativeTuiFeatureGateOptions = {
  env?: Record<string, string | undefined>;
  platform?: string;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  capabilities?: NativeTuiCapability;
};

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);

function readMode(env: Record<string, string | undefined>): NativeTuiMode {
  const value = env[NATIVE_TUI_ENV]?.trim().toLowerCase();
  return value === "on" || value === "off" || value === "auto" ? value : "auto";
}

function resolveCapability(
  env: Record<string, string | undefined>,
  capabilities: NativeTuiCapability | undefined,
): boolean {
  if (capabilities?.nativeTui !== undefined) return capabilities.nativeTui;

  // A missing TERM is common in embedded callers. TTY checks remain the
  // hard interactivity gate, while an explicitly dumb terminal is not.
  return env.TERM?.trim().toLowerCase() !== "dumb";
}

export function resolveNativeTuiFeatureGate(
  options: NativeTuiFeatureGateOptions = {},
): NativeTuiFeatureGate {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const requestedMode = readMode(env);
  const mode = requestedMode;
  const platformSupported = SUPPORTED_PLATFORMS.has(platform);
  const stdinIsTTY = options.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const stdoutIsTTY = options.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  const capability = resolveCapability(env, options.capabilities);

  let reason: NativeTuiFeatureGate["reason"] = "enabled";
  if (mode === "off") reason = "explicit-off";
  else if (!platformSupported) reason = "unsupported-platform";
  else if (!stdinIsTTY) reason = "stdin-not-tty";
  else if (!stdoutIsTTY) reason = "stdout-not-tty";
  else if (!capability) reason = "insufficient-capability";

  return {
    enabled: reason === "enabled",
    mode,
    requestedMode,
    platform,
    platformSupported,
    stdinIsTTY,
    stdoutIsTTY,
    capability,
    reason,
  };
}

export function isNativeTuiEnabled(
  options: NativeTuiFeatureGateOptions = {},
): boolean {
  return resolveNativeTuiFeatureGate(options).enabled;
}
