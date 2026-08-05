import React, { useEffect, useState } from "react";
import { Spinner } from "../components/Spinner.js";
import { useTimeout } from "../hooks/useTimeout.js";
import { Box, Text } from "../ink.js";
import {
  VEXZY_API_KEY_ENV,
  VEXZY_OPENAI_ENDPOINTS,
} from "../services/api/vexzy/config.js";

export interface PreflightCheckResult {
  success: boolean;
  error?: string;
}

export interface VexzyFetchOptions {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Check the VEXZY model catalog without exposing the API key in errors. */
export async function checkVexzyConnection({
  fetchImpl = globalThis.fetch,
  apiKey = process.env[VEXZY_API_KEY_ENV],
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: VexzyFetchOptions = {}): Promise<PreflightCheckResult> {
  if (!apiKey) {
    return {
      success: false,
      error: "VEXZY_API_KEY is not configured",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(VEXZY_OPENAI_ENDPOINTS.models, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (response.status === 200) {
      return { success: true };
    }

    if (response.status === 401) {
      return {
        success: false,
        error: "VEXZY API authentication failed (HTTP 401)",
      };
    }

    return {
      success: false,
      error: `VEXZY API request failed (HTTP ${response.status})`,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        success: false,
        error: `VEXZY API request timed out after ${timeoutMs}ms`,
      };
    }

    return {
      success: false,
      error: `Unable to reach VEXZY API: ${
        error instanceof Error ? error.message : "network error"
      }`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

interface PreflightStepProps {
  onSuccess: () => void;
}

export function PreflightStep({ onSuccess }: PreflightStepProps) {
  const [result, setResult] = useState<PreflightCheckResult | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const showSpinner = useTimeout(1000) && isChecking;

  useEffect(() => {
    let cancelled = false;

    void checkVexzyConnection().then((checkResult) => {
      if (!cancelled) {
        setResult(checkResult);
        setIsChecking(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!result) return;
    if (result.success) {
      onSuccess();
      return;
    }

    const timer = setTimeout(() => process.exit(1), 100);
    return () => clearTimeout(timer);
  }, [onSuccess, result]);

  const content =
    isChecking && showSpinner ? (
      <Box paddingLeft={1}>
        <Spinner />
        <Text>Checking VEXZY API connectivity...</Text>
      </Box>
    ) : !result?.success && !isChecking ? (
      <Box flexDirection="column" gap={1}>
        <Text color="error">Unable to connect to VEXZY API</Text>
        <Text color="error">{result?.error}</Text>
        <Text>Please check VEXZY_API_KEY and your network connection.</Text>
      </Box>
    ) : null;

  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      {content}
    </Box>
  );
}
