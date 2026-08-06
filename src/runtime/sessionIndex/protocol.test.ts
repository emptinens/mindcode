import { describe, expect, test } from "bun:test";
import { SessionIndexProtocolError } from "./errors.js";
import {
  validateGetResult,
  validateListParams,
  validateSearchParams,
  validateSessionRecord,
} from "./protocol.js";

const record = {
  session_id: "session-1",
  project_path: "/work/project",
  transcript_path: "/state/session-1.jsonl",
  modified_at_ms: Number.MAX_SAFE_INTEGER,
  size_bytes: Number.MAX_SAFE_INTEGER,
};

describe("session index protocol validators", () => {
  test("uses the Rust cursor field and rejects the old offset wire key", () => {
    expect(
      validateListParams({
        project_path: "/work/project",
        limit: 0,
        before_modified_at_ms: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({
      project_path: "/work/project",
      limit: 0,
      before_modified_at_ms: Number.MAX_SAFE_INTEGER,
    });
    expect(() => validateListParams({ offset: 1 })).toThrow(
      SessionIndexProtocolError,
    );
    expect(
      validateSearchParams({
        query: "session",
        before_modified_at_ms: 0,
      }),
    ).toEqual({ query: "session", before_modified_at_ms: 0 });
  });

  test("accepts safe integer boundaries and rejects unsafe numbers", () => {
    expect(validateSessionRecord(record)).toEqual(record);
    expect(() =>
      validateSessionRecord({
        ...record,
        size_bytes: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow("safe integer");
    expect(() =>
      validateListParams({
        before_modified_at_ms: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow("safe integer");
    expect(() =>
      validateSearchParams({ query: "x", before_modified_at_ms: -1 }),
    ).toThrow("non-negative");
  });

  test("rejects malformed daemon results without accepting null records", () => {
    expect(() => validateGetResult({ session: null, extra: true })).toThrow(
      SessionIndexProtocolError,
    );
    expect(() =>
      validateGetResult({ session: { ...record, title: null } }),
    ).toThrow(SessionIndexProtocolError);
  });
});
