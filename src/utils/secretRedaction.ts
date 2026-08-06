const SECRET_PATTERNS: readonly RegExp[] = [
  /\bforge-[A-Za-z0-9._~-]+/gi,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/gi,
  /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\bx-api-key\s*:\s*[^\s,;]+/gi,
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (result, pattern) => result.replace(pattern, "[REDACTED]"),
    value,
  );
}
