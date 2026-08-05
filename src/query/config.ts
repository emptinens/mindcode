import { getSessionId } from '../bootstrap/state.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import type { SessionId } from '../types/ids.js'
import { isEnvTruthy } from '../utils/envUtils.js'

// -- config

// Immutable values snapshotted once at query() entry. Separating these from
// the per-iteration State struct and the mutable ToolUseContext makes future
// step() extraction tractable — a pure reducer can take (state, event, config)
// where config is plain data.
//
// Intentionally excludes feature() gates — those are tree-shaking boundaries
// and must stay inline at the guarded blocks for dead-code elimination.
export type QueryConfig = {
  sessionId: SessionId

  // Runtime gates (env/statsig). NOT feature() gates — see above.
  gates: {
    // Statsig — CACHED_MAY_BE_STALE already admits staleness, so snapshotting
    // once per query() call stays within the existing contract.
    streamingToolExecution: boolean
    emitToolUseSummaries: boolean
    isAnt: boolean
    fastModeEnabled: boolean
  }
}

export function buildQueryConfig(): QueryConfig {
  return {
    sessionId: getSessionId(),
    gates: {
      // Default-on (upstream made streaming tool execution always-enabled in
      // 2.1.154); required for live in-progress tool rendering, e.g. the
      // workflow agent tree. Opt out with MINDCODE_DISABLE_STREAMING_TOOL_EXECUTION=1.
      streamingToolExecution:
        !isEnvTruthy(
          process.env.MINDCODE_DISABLE_STREAMING_TOOL_EXECUTION,
        ) ||
        checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
          'tengu_streaming_tool_execution2',
        ),
      emitToolUseSummaries: isEnvTruthy(
        process.env.MINDCODE_EMIT_TOOL_USE_SUMMARIES,
      ),
      isAnt: process.env.USER_TYPE === 'ant',
      // Inlined from fastMode.ts to avoid pulling its heavy module graph
      // (axios, settings, auth, model, oauth, config) into test shards that
      // didn't previously load it — changes init order and breaks unrelated tests.
      fastModeEnabled: !isEnvTruthy(process.env.MINDCODE_DISABLE_FAST_MODE),
    },
  }
}
