import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DIAGNOSTIC_EXPORT_SCHEMA = 1 as const;
const MAX_DIAGNOSTIC_BYTES = 256 * 1024;
const MAX_STRING_BYTES = 4 * 1024;
const MAX_ARRAY_ITEMS = 256;
const MAX_OBJECT_KEYS = 128;
const SENSITIVE_KEY =
  /(?:api.?key|authorization|bearer|credential|password|secret|prompt|transcript|source|diff|response|body|token)/iu;
const ABSOLUTE_PATH = /(?:^|[=\s("'`])(?:~\/|\/(?!\/)|[A-Za-z]:[\\/])/u;
const SECRET_VALUE = /(?:forge-[A-Za-z0-9._-]+|Bearer\s+\S+)/iu;

export type DiagnosticExportOptions = {
  jsonPath: string;
  htmlPath: string;
  metadata: Record<string, unknown>;
};

export type DiagnosticExportResult = {
  schema: typeof DIAGNOSTIC_EXPORT_SCHEMA;
  jsonPath: string;
  htmlPath: string;
  bytes: number;
};

function safeString(value: string): string {
  if (SECRET_VALUE.test(value) || ABSOLUTE_PATH.test(value))
    return "[redacted]";
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= MAX_STRING_BYTES) return value;
  return `${value.slice(0, MAX_STRING_BYTES - 3)}...`;
}

function sanitize(value: unknown, depth = 0, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") return safeString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return value;
  if (depth >= 4) return "[bounded]";
  if (Array.isArray(value))
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitize(item, depth + 1, key));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value).slice(
      0,
      MAX_OBJECT_KEYS,
    )) {
      output[childKey] = sanitize(childValue, depth + 1, childKey);
    }
    return output;
  }
  return "[unsupported]";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function diagnosticHtml(value: Record<string, unknown>): string {
  const json = JSON.stringify(value, null, 2);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>MindCode diagnostics</title><style>body{margin:2rem;background:#fff;color:#111;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #999;padding:1rem;background:#f6f6f6}</style></head><body><h1>MindCode diagnostics</h1><pre>${escapeHtml(json)}</pre></body></html>\n`;
}

export async function writeDiagnosticExport(
  options: DiagnosticExportOptions,
): Promise<DiagnosticExportResult> {
  const jsonPath = options.jsonPath.trim();
  const htmlPath = options.htmlPath.trim();
  if (!jsonPath || !htmlPath)
    throw new TypeError("diagnostic output paths are required");
  if (jsonPath === htmlPath)
    throw new TypeError("diagnostic JSON and HTML paths must differ");
  if (!jsonPath.startsWith("/") || !htmlPath.startsWith("/"))
    throw new TypeError("diagnostic output paths must be absolute");
  const metadata = sanitize({
    schema: DIAGNOSTIC_EXPORT_SCHEMA,
    ...options.metadata,
  }) as Record<string, unknown>;
  const json = `${JSON.stringify(metadata, null, 2)}\n`;
  const html = diagnosticHtml(metadata);
  if (
    Buffer.byteLength(json, "utf8") > MAX_DIAGNOSTIC_BYTES ||
    Buffer.byteLength(html, "utf8") > MAX_DIAGNOSTIC_BYTES
  )
    throw new RangeError("diagnostic export exceeds its size bound");
  await Promise.all([
    mkdir(dirname(jsonPath), { recursive: true, mode: 0o700 }),
    mkdir(dirname(htmlPath), { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    writeFile(jsonPath, json, { encoding: "utf8", mode: 0o600 }),
    writeFile(htmlPath, html, { encoding: "utf8", mode: 0o600 }),
  ]);
  await Promise.all([chmod(jsonPath, 0o600), chmod(htmlPath, 0o600)]);
  return {
    schema: DIAGNOSTIC_EXPORT_SCHEMA,
    jsonPath,
    htmlPath,
    bytes: Buffer.byteLength(json, "utf8") + Buffer.byteLength(html, "utf8"),
  };
}
