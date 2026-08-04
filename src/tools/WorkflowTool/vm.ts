// The workflow VM runner + DSL hooks.
//
// Executes a workflow script body inside a node:vm context with the orchestration
// globals (agent/parallel/pipeline/phase/log/workflow/args/budget) bound. The
// context is hardened (dangerous globals deleted, eval disabled via
// codeGeneration:false) and Date.now()/Math.random() are neutralized so runs
// stay deterministic (a prerequisite for resume).

import vm from 'node:vm'
import {
  WORKFLOW_AGENT_CALL_CAP,
  WORKFLOW_DEFAULT_CONCURRENCY,
  WORKFLOW_SYNC_TIMEOUT_MS,
} from './constants.js'
import type { SubagentRunResult } from './subagent.js'

export type AgentState =
  | 'queued'
  | 'running'
  | 'done'
  | 'error'
  | 'skipped'

export type AgentUpdate = {
  agentId: string
  index: number
  label: string
  phaseIndex?: number
  phaseTitle?: string
  state: AgentState
  promptPreview?: string
  tokens?: number
  error?: string
}

export type AgentCallSpec = {
  prompt: string
  schema?: unknown
  model?: string
  effort?: string
  isolation?: string
  agentType?: string
  index: number
  agentId: string
  label: string
  phaseIndex?: number
  phaseTitle?: string
  controller: AbortController
}

export type WorkflowHooks = {
  onLog: (msg: string) => void
  onAgentUpdate: (u: AgentUpdate) => void
  /** Run a single agent() call to completion. */
  runAgentCall: (spec: AgentCallSpec) => Promise<SubagentRunResult>
  /** Resolve a saved/built-in workflow's script body for nested workflow(). */
  resolveWorkflowScript: (name: string) => string | undefined
  abortSignal: AbortSignal
  budgetTotal: number | null
}

export type RunWorkflowResult = {
  result?: unknown
  error?: string
  agentCount: number
  tokensSpent: number
}

const DATE_NOW_MSG =
  'Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.'
const MATH_RANDOM_MSG =
  'Math.random() is unavailable in workflow scripts (breaks resume). For N independent samples, include the index in the agent label or prompt.'

/** Delete dangerous globals + neutralize non-deterministic clocks in-context. */
function hardenContext(context: vm.Context): void {
  const HARDEN_PRELUDE = `
    for (const g of ['ShadowRealm','WebAssembly','FinalizationRegistry','WeakRef',
                     'Atomics','SharedArrayBuffer','queueMicrotask','$vm','gc',
                     'edenGC','fullGC','print','readFile','Loader']) {
      try { delete globalThis[g] } catch (_) {}
    }
    Date.now = function () { throw new Error(${JSON.stringify(DATE_NOW_MSG)}) }
    Math.random = function () { throw new Error(${JSON.stringify(MATH_RANDOM_MSG)}) }
  `
  vm.runInContext(HARDEN_PRELUDE, context, { timeout: 1000 })
}

function preview(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > 100 ? one.slice(0, 100) + '…' : one
}

export async function runWorkflowScript(
  scriptBody: string,
  args: unknown,
  hooks: WorkflowHooks,
): Promise<RunWorkflowResult> {
  let agentCount = 0
  let tokensSpent = 0
  let nextIndex = 0
  let agentIdSeq = 0
  let phaseIndex = -1
  let phaseTitle: string | undefined
  let nestingDepth = 0

  const throwIfAborted = () => {
    if (hooks.abortSignal.aborted) throw new Error('Workflow aborted')
  }

  // Bounded-concurrency gate shared across parallel()/pipeline() in the run.
  let active = 0
  const waiters: Array<() => void> = []
  const acquire = async () => {
    if (active < WORKFLOW_DEFAULT_CONCURRENCY) {
      active++
      return
    }
    await new Promise<void>(res => waiters.push(res))
    active++
  }
  const release = () => {
    active--
    const w = waiters.shift()
    if (w) w()
  }

  const budget = {
    total: hooks.budgetTotal,
    spent: () => tokensSpent,
    remaining: () =>
      hooks.budgetTotal == null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, hooks.budgetTotal - tokensSpent),
  }

  async function agentHook(
    prompt: string,
    opts?: {
      label?: string
      phase?: string
      schema?: unknown
      model?: string
      effort?: string
      isolation?: string
      agentType?: string
    },
  ): Promise<unknown> {
    throwIfAborted()
    if (agentCount >= WORKFLOW_AGENT_CALL_CAP) {
      throw new Error(
        `Workflow agent() call cap reached (${WORKFLOW_AGENT_CALL_CAP}). This usually means a loop using budget.remaining() never terminates because no token budget was set — remaining() returns Infinity when budget.total is null. Add a hard iteration cap to the loop, or pass a token budget.`,
      )
    }
    if (
      budget.total != null &&
      tokensSpent >= budget.total
    ) {
      throw new Error(
        `Workflow token budget exhausted (${budget.total}). Stop spawning agents.`,
      )
    }
    agentCount++
    const index = nextIndex++
    const agentId = `a${agentIdSeq++}`
    const label = opts?.label ?? preview(prompt).slice(0, 40)
    const pIndex = opts?.phase ? phaseIndex : phaseIndex
    const pTitle = opts?.phase ?? phaseTitle
    const controller = new AbortController()
    const onParentAbort = () => controller.abort()
    hooks.abortSignal.addEventListener('abort', onParentAbort, { once: true })

    const base: AgentUpdate = {
      agentId,
      index,
      label,
      phaseIndex: pIndex,
      phaseTitle: pTitle,
      state: 'running',
      promptPreview: preview(prompt),
    }
    hooks.onAgentUpdate(base)

    await acquire()
    try {
      throwIfAborted()
      const res = await hooks.runAgentCall({
        prompt,
        schema: opts?.schema,
        model: opts?.model,
        effort: opts?.effort,
        isolation: opts?.isolation,
        agentType: opts?.agentType,
        index,
        agentId,
        label,
        phaseIndex: pIndex,
        phaseTitle: pTitle,
        controller,
      })
      tokensSpent += res.tokens || 0
      if (res.skipped) {
        hooks.onAgentUpdate({ ...base, state: 'skipped', tokens: res.tokens })
        return null
      }
      if (res.error) {
        hooks.onAgentUpdate({
          ...base,
          state: 'error',
          tokens: res.tokens,
          error: res.error,
        })
        return null
      }
      hooks.onAgentUpdate({ ...base, state: 'done', tokens: res.tokens })
      return opts?.schema !== undefined ? res.structured : res.text
    } finally {
      hooks.abortSignal.removeEventListener('abort', onParentAbort)
      release()
    }
  }

  function parallelHook(
    thunks: Array<() => Promise<unknown>>,
  ): Promise<unknown[]> {
    if (!Array.isArray(thunks)) {
      throw new Error('parallel() expects an array of functions')
    }
    return Promise.all(
      thunks.map(async t => {
        if (typeof t !== 'function') {
          throw new Error(
            'parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)',
          )
        }
        try {
          return await t()
        } catch (e) {
          if (hooks.abortSignal.aborted) throw e
          return null
        }
      }),
    )
  }

  function pipelineHook(
    items: unknown[],
    ...stages: Array<
      (prev: unknown, item: unknown, index: number) => Promise<unknown>
    >
  ): Promise<unknown[]> {
    if (!Array.isArray(items)) {
      throw new Error('pipeline() expects an array as its first argument')
    }
    // Each item flows through all stages independently (no barrier between stages).
    return Promise.all(
      items.map(async (item, i) => {
        let prev: unknown = item
        for (const stage of stages) {
          try {
            prev = await stage(prev, item, i)
          } catch (e) {
            if (hooks.abortSignal.aborted) throw e
            return null
          }
          if (prev === null) return null
        }
        return prev
      }),
    )
  }

  function phaseHook(title: string): void {
    phaseIndex++
    phaseTitle = String(title)
  }

  function logHook(message: string): void {
    hooks.onLog(String(message))
  }

  async function workflowHook(
    nameOrRef: string | { scriptPath?: string },
    childArgs?: unknown,
  ): Promise<unknown> {
    if (nestingDepth > 0) {
      throw new Error('workflow() nesting is one level only')
    }
    const name = typeof nameOrRef === 'string' ? nameOrRef : undefined
    if (!name) {
      throw new Error('workflow() requires a workflow name')
    }
    const childScript = hooks.resolveWorkflowScript(name)
    if (!childScript) {
      throw new Error(`workflow("${name}") not found`)
    }
    nestingDepth++
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { parseWorkflowScript } =
        require('./meta.js') as typeof import('./meta.js')
      const parsed = parseWorkflowScript(childScript)
      if ('error' in parsed) {
        throw new Error(`workflow("${name}") syntax error: ${parsed.error}`)
      }
      const child = await runWorkflowScript(parsed.scriptBody, childArgs, hooks)
      if (child.error) throw new Error(child.error)
      return child.result
    } finally {
      nestingDepth--
    }
  }

  const contextObject: Record<string, unknown> = {
    agent: agentHook,
    parallel: parallelHook,
    pipeline: pipelineHook,
    phase: phaseHook,
    log: logHook,
    workflow: workflowHook,
    budget,
    args,
    console: {
      log: (...a: unknown[]) => hooks.onLog(a.map(String).join(' ')),
      error: (...a: unknown[]) => hooks.onLog(a.map(String).join(' ')),
      warn: (...a: unknown[]) => hooks.onLog(a.map(String).join(' ')),
    },
    setTimeout,
    clearTimeout,
  }

  const context = vm.createContext(contextObject, {
    codeGeneration: { strings: false, wasm: false },
  })
  hardenContext(context)

  // Wrap the body in an async IIFE so top-level `await` and `return` are valid.
  const wrapped = `(async () => {\n${scriptBody}\n})()`
  try {
    const promise = vm.runInContext(wrapped, context, {
      timeout: WORKFLOW_SYNC_TIMEOUT_MS,
      filename: 'workflow.js',
    }) as Promise<unknown>
    const result = await promise
    return { result, agentCount, tokensSpent }
  } catch (e) {
    return {
      error: (e as Error).message,
      agentCount,
      tokensSpent,
    }
  }
}
