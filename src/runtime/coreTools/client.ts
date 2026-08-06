import {
  DaemonClientError,
  DaemonDisabledError,
  DaemonTimeoutError,
  classifyDaemonFallback,
} from "../daemon/errors.js";
import { getDaemonManager } from "../daemon/manager.js";
import type { DaemonCallResult } from "../daemon/types.js";
import { CoreToolsProtocolError } from "./errors.js";
import {
  type CoreToolsDaemonTransport,
  type CoreToolsRequestOptions,
  type GitDiffParams,
  type GitDiffResult,
  type GitRevParseParams,
  type GitRevParseResult,
  type GitRootParams,
  type GitRootResult,
  type GitStatusParams,
  type GitStatusResult,
  type ProcessRunParams,
  type ProcessRunResult,
  validateGitDiffParams,
  validateGitDiffResult,
  validateGitRevParseParams,
  validateGitRevParseResult,
  validateGitRootParams,
  validateGitRootResult,
  validateGitStatusParams,
  validateGitStatusResult,
  validateProcessRunParams,
  validateProcessRunResult,
} from "./protocol.js";

export type CoreToolsFallback<T> = () => T | Promise<T>;

const FALLBACK_MARKER = Object.freeze({ coreToolsFallbackMarker: true });

export class CoreToolsDaemonClient {
  private readonly transport: CoreToolsDaemonTransport;

  constructor(transport: CoreToolsDaemonTransport = getDaemonManager()) {
    if (!transport.request && !transport.requestWithFallback) {
      throw new TypeError(
        "Core tools transport must expose request or requestWithFallback",
      );
    }
    this.transport = transport;
  }

  async processRun(
    params: ProcessRunParams,
    options?: CoreToolsRequestOptions,
  ): Promise<ProcessRunResult> {
    return this.call(
      "process.run",
      validateProcessRunParams(params),
      validateProcessRunResult,
      options,
    );
  }

  async run(
    params: ProcessRunParams,
    options?: CoreToolsRequestOptions,
  ): Promise<ProcessRunResult> {
    return this.processRun(params, options);
  }

  async gitRoot(
    params: GitRootParams,
    options?: CoreToolsRequestOptions,
  ): Promise<GitRootResult> {
    return this.call(
      "git.root",
      validateGitRootParams(params),
      validateGitRootResult,
      options,
    );
  }

  async root(
    params: GitRootParams,
    options?: CoreToolsRequestOptions,
  ): Promise<GitRootResult> {
    return this.gitRoot(params, options);
  }

  async gitStatus(
    params: GitStatusParams,
    options?: CoreToolsRequestOptions,
  ): Promise<GitStatusResult> {
    return this.call(
      "git.status",
      validateGitStatusParams(params),
      validateGitStatusResult,
      options,
    );
  }

  async status(
    params: GitStatusParams,
    options?: CoreToolsRequestOptions,
  ): Promise<GitStatusResult> {
    return this.gitStatus(params, options);
  }

  async gitDiff(
    params: GitDiffParams,
    options?: CoreToolsRequestOptions,
  ): Promise<GitDiffResult> {
    return this.call(
      "git.diff",
      validateGitDiffParams(params),
      validateGitDiffResult,
      options,
    );
  }

  async diff(
    params: GitDiffParams,
    options?: CoreToolsRequestOptions,
  ): Promise<GitDiffResult> {
    return this.gitDiff(params, options);
  }

  async gitRevParse(
    params: GitRevParseParams,
    options?: CoreToolsRequestOptions,
  ): Promise<GitRevParseResult> {
    return this.call(
      "git.rev_parse",
      validateGitRevParseParams(params),
      validateGitRevParseResult,
      options,
    );
  }

  async revParse(
    params: GitRevParseParams,
    options?: CoreToolsRequestOptions,
  ): Promise<GitRevParseResult> {
    return this.gitRevParse(params, options);
  }

  async gitRootWithFallback(
    params: GitRootParams,
    fallback: CoreToolsFallback<GitRootResult>,
    options?: CoreToolsRequestOptions,
  ): Promise<DaemonCallResult<GitRootResult>> {
    return this.callReadWithFallback(
      "git.root",
      validateGitRootParams(params),
      fallback,
      validateGitRootResult,
      options,
    );
  }

  async rootWithFallback(
    params: GitRootParams,
    fallback: CoreToolsFallback<GitRootResult>,
    options?: CoreToolsRequestOptions,
  ): Promise<DaemonCallResult<GitRootResult>> {
    return this.gitRootWithFallback(params, fallback, options);
  }

  async gitStatusWithFallback(
    params: GitStatusParams,
    fallback: CoreToolsFallback<GitStatusResult>,
    options?: CoreToolsRequestOptions,
  ): Promise<DaemonCallResult<GitStatusResult>> {
    return this.callReadWithFallback(
      "git.status",
      validateGitStatusParams(params),
      fallback,
      validateGitStatusResult,
      options,
    );
  }

  async statusWithFallback(
    params: GitStatusParams,
    fallback: CoreToolsFallback<GitStatusResult>,
    options?: CoreToolsRequestOptions,
  ): Promise<DaemonCallResult<GitStatusResult>> {
    return this.gitStatusWithFallback(params, fallback, options);
  }

  async gitDiffWithFallback(
    params: GitDiffParams,
    fallback: CoreToolsFallback<GitDiffResult>,
    options?: CoreToolsRequestOptions,
  ): Promise<DaemonCallResult<GitDiffResult>> {
    return this.callReadWithFallback(
      "git.diff",
      validateGitDiffParams(params),
      fallback,
      validateGitDiffResult,
      options,
    );
  }

  async diffWithFallback(
    params: GitDiffParams,
    fallback: CoreToolsFallback<GitDiffResult>,
    options?: CoreToolsRequestOptions,
  ): Promise<DaemonCallResult<GitDiffResult>> {
    return this.gitDiffWithFallback(params, fallback, options);
  }

  async gitRevParseWithFallback(
    params: GitRevParseParams,
    fallback: CoreToolsFallback<GitRevParseResult>,
    options?: CoreToolsRequestOptions,
  ): Promise<DaemonCallResult<GitRevParseResult>> {
    return this.callReadWithFallback(
      "git.rev_parse",
      validateGitRevParseParams(params),
      fallback,
      validateGitRevParseResult,
      options,
    );
  }

  async revParseWithFallback(
    params: GitRevParseParams,
    fallback: CoreToolsFallback<GitRevParseResult>,
    options?: CoreToolsRequestOptions,
  ): Promise<DaemonCallResult<GitRevParseResult>> {
    return this.gitRevParseWithFallback(params, fallback, options);
  }

  private async call<T>(
    method: string,
    params: unknown,
    validator: (value: unknown) => T,
    options?: CoreToolsRequestOptions,
  ): Promise<T> {
    if (this.transport.request) {
      return validator(
        await this.transport.request<unknown>(method, params, options),
      );
    }
    const requestWithFallback = this.transport.requestWithFallback;
    if (!requestWithFallback) {
      throw new CoreToolsProtocolError("Core tools transport is unavailable");
    }
    const result = await requestWithFallback<unknown>(
      method,
      params,
      FALLBACK_MARKER,
      options,
    );
    if (result.source === "fallback") {
      throw unavailableError(result.error);
    }
    return validator(result.value);
  }

  private async callReadWithFallback<T>(
    method: string,
    params: unknown,
    fallback: CoreToolsFallback<T>,
    validator: (value: unknown) => T,
    options?: CoreToolsRequestOptions,
  ): Promise<DaemonCallResult<T>> {
    if (this.transport.requestWithFallback) {
      const result = await this.transport.requestWithFallback<unknown>(
        method,
        params,
        FALLBACK_MARKER,
        options,
      );
      if (result.source === "daemon") {
        return { source: "daemon", value: validator(result.value) };
      }
      const error = result.error;
      if (!isPreDispatchUnavailable(error)) {
        throw unavailableError(error);
      }
      return {
        source: "fallback",
        value: validator(await fallback()),
        reason: classifyDaemonFallback(error),
        error,
      };
    }

    const request = this.transport.request;
    if (!request) {
      throw new CoreToolsProtocolError("Core tools transport is unavailable");
    }
    try {
      return {
        source: "daemon",
        value: validator(await request<unknown>(method, params, options)),
      };
    } catch (error) {
      if (!isPreDispatchUnavailable(error)) throw error;
      return {
        source: "fallback",
        value: validator(await fallback()),
        reason: classifyDaemonFallback(error),
        error,
      };
    }
  }
}

function isPreDispatchUnavailable(error: unknown): boolean {
  if (error instanceof DaemonDisabledError) return true;
  if (error instanceof DaemonTimeoutError) {
    return error.kind === "connect" || error.kind === "handshake";
  }
  return (
    error instanceof DaemonClientError && error.code === "DAEMON_UNAVAILABLE"
  );
}

function unavailableError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new CoreToolsProtocolError(
    "Daemon fallback result did not include an error",
  );
}

export type {
  CoreToolsDaemonTransport,
  CoreToolsRequestOptions,
  GitDiffParams,
  GitDiffResult,
  GitRootParams,
  GitRootResult,
  GitRevParseParams,
  GitRevParseResult,
  GitStatusParams,
  GitStatusResult,
  ProcessRunParams,
  ProcessRunResult,
};
