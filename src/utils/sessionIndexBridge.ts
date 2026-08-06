import { stat as fsStat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  FIRST_PROMPT_MAX_LENGTH,
  SessionIndexDaemonClient,
  type SessionIndexRecord,
  TITLE_MAX_LENGTH,
} from "../runtime/sessionIndex/index.js";
import { redactSecrets } from "./secretRedaction.js";

export type SessionFileSnapshot = {
  sessionId: string;
  path: string;
  mtime: number;
  ctime: number;
  size: number;
  title?: string;
  firstPrompt?: string;
};

export type SessionIndexListing = {
  files: SessionFileSnapshot[];
  source: "daemon" | "filesystem";
};

export type SessionIndexClientLike = Pick<
  SessionIndexDaemonClient,
  "listWithFallback" | "upsert" | "remove"
>;

export type SessionIndexBridgeOptions = {
  client?: SessionIndexClientLike;
  statFile?: typeof fsStat;
  onWriteError?: (operation: "upsert" | "remove") => void;
};

type RefreshInput = {
  sessionId: string;
  projectDir: string;
  transcriptPath: string;
  title?: string;
  firstPrompt?: string;
};

/**
 * Narrow write-through boundary between transcript storage and the native
 * metadata index. The index never receives transcript bodies or credentials.
 */
export class SessionIndexBridge {
  private readonly client: SessionIndexClientLike;
  private readonly statFile: typeof fsStat;
  private readonly onWriteError?: (operation: "upsert" | "remove") => void;
  private readonly queuedWrites = new Map<
    string,
    { signature: string; promise: Promise<boolean> }
  >();
  private readonly persistedSignatures = new Map<string, string>();

  constructor(options: SessionIndexBridgeOptions = {}) {
    this.client = options.client ?? new SessionIndexDaemonClient();
    this.statFile = options.statFile ?? fsStat;
    this.onWriteError = options.onWriteError;
  }

  async listOrScan(
    projectDir: string,
    limit: number | undefined,
    scan: () => Promise<SessionFileSnapshot[]>,
  ): Promise<SessionIndexListing> {
    let fallbackFiles: SessionFileSnapshot[] | undefined;
    const requestedLimit = normalizeLimit(limit);
    const params = {
      project_path: projectDir,
      limit: requestedLimit,
    };
    const result = await this.client.listWithFallback(params, async () => {
      fallbackFiles = applyLimit(sortSnapshots(await scan()), limit);
      return {
        sessions: fallbackFiles.map((file) =>
          snapshotToRecord(projectDir, file),
        ),
      };
    });

    if (result.source === "fallback") {
      return {
        files:
          fallbackFiles ??
          result.value.sessions.map((record) => recordToSnapshot(record)),
        source: "filesystem",
      };
    }

    const indexed = result.value.sessions
      .filter((record) => isOwnedRecord(projectDir, record))
      .map((record) => recordToSnapshot(record));
    if (indexed.length > 0) {
      return { files: indexed, source: "daemon" };
    }

    const scanned = sortSnapshots(await scan());
    await Promise.all(scanned.map((file) => this.upsert(projectDir, file)));
    return { files: applyLimit(scanned, limit), source: "filesystem" };
  }

  async refresh(input: RefreshInput): Promise<boolean> {
    if (
      !isOwnedTranscript(
        input.projectDir,
        input.sessionId,
        input.transcriptPath,
      )
    ) {
      return false;
    }
    try {
      const file = await this.statFile(input.transcriptPath);
      return this.upsert(input.projectDir, {
        sessionId: input.sessionId,
        path: input.transcriptPath,
        mtime: file.mtime.getTime(),
        ctime: file.birthtime.getTime(),
        size: file.size,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.firstPrompt === undefined
          ? {}
          : { firstPrompt: input.firstPrompt }),
      });
    } catch {
      this.onWriteError?.("upsert");
      return false;
    }
  }

  upsert(projectDir: string, file: SessionFileSnapshot): Promise<boolean> {
    if (!isOwnedTranscript(projectDir, file.sessionId, file.path)) {
      return Promise.resolve(false);
    }
    const record = snapshotToRecord(projectDir, file);
    const signature = JSON.stringify(record);
    if (this.persistedSignatures.get(record.session_id) === signature) {
      return Promise.resolve(true);
    }
    const queued = this.queuedWrites.get(record.session_id);
    if (queued?.signature === signature) return queued.promise;

    const previous = queued?.promise ?? Promise.resolve(true);
    const promise = previous
      .catch(() => false)
      .then(async () => {
        if (this.persistedSignatures.get(record.session_id) === signature) {
          return true;
        }
        try {
          await this.client.upsert(record);
          this.persistedSignatures.set(record.session_id, signature);
          return true;
        } catch {
          this.onWriteError?.("upsert");
          return false;
        }
      })
      .finally(() => {
        if (this.queuedWrites.get(record.session_id)?.promise === promise) {
          this.queuedWrites.delete(record.session_id);
        }
      });
    this.queuedWrites.set(record.session_id, { signature, promise });
    return promise;
  }

  async remove(sessionId: string): Promise<boolean> {
    try {
      const result = await this.client.remove(sessionId);
      this.persistedSignatures.delete(sessionId);
      return result.removed;
    } catch {
      this.onWriteError?.("remove");
      return false;
    }
  }
}

function snapshotToRecord(
  projectDir: string,
  file: SessionFileSnapshot,
): SessionIndexRecord {
  return {
    session_id: file.sessionId,
    project_path: projectDir,
    transcript_path: file.path,
    modified_at_ms: safeFileInteger(file.mtime),
    size_bytes: safeFileInteger(file.size),
    ...(file.title === undefined
      ? {}
      : { title: safeMetadata(file.title, TITLE_MAX_LENGTH) }),
    ...(file.firstPrompt === undefined
      ? {}
      : {
          first_prompt: safeMetadata(file.firstPrompt, FIRST_PROMPT_MAX_LENGTH),
        }),
  };
}

function recordToSnapshot(record: SessionIndexRecord): SessionFileSnapshot {
  return {
    sessionId: record.session_id,
    path: record.transcript_path,
    mtime: record.modified_at_ms,
    ctime: record.modified_at_ms,
    size: record.size_bytes,
    ...(record.title === undefined ? {} : { title: record.title }),
    ...(record.first_prompt === undefined
      ? {}
      : { firstPrompt: record.first_prompt }),
  };
}

function sortSnapshots(files: SessionFileSnapshot[]): SessionFileSnapshot[] {
  return [...files].sort(
    (left, right) =>
      right.mtime - left.mtime || left.sessionId.localeCompare(right.sessionId),
  );
}

function applyLimit(
  files: SessionFileSnapshot[],
  limit: number | undefined,
): SessionFileSnapshot[] {
  return limit && files.length > limit ? files.slice(0, limit) : files;
}

function normalizeLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 1_000;
  return Math.min(1_000, Math.max(1, Math.floor(limit)));
}

function isOwnedRecord(
  projectDir: string,
  record: SessionIndexRecord,
): boolean {
  return (
    resolve(record.project_path) === resolve(projectDir) &&
    isOwnedTranscript(projectDir, record.session_id, record.transcript_path)
  );
}

function isOwnedTranscript(
  projectDir: string,
  sessionId: string,
  transcriptPath: string,
): boolean {
  return (
    resolve(dirname(transcriptPath)) === resolve(projectDir) &&
    basename(transcriptPath) === `${sessionId}.jsonl`
  );
}

function safeFileInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return value;
}

function safeMetadata(value: string, maxBytes: number): string {
  const redacted = redactSecrets(value);
  if (Buffer.byteLength(redacted, "utf8") <= maxBytes) return redacted;
  let end = Math.min(redacted.length, maxBytes);
  while (
    end > 0 &&
    Buffer.byteLength(redacted.slice(0, end), "utf8") > maxBytes
  ) {
    end--;
  }
  return redacted.slice(0, end);
}

let bridge: SessionIndexBridge | undefined;

export function getSessionIndexBridge(): SessionIndexBridge {
  bridge ??= new SessionIndexBridge();
  return bridge;
}

export function setSessionIndexBridgeForTesting(
  replacement: SessionIndexBridge | undefined,
): void {
  bridge = replacement;
}
