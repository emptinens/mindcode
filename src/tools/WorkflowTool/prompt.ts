// The WorkflowTool model-facing prompt (the X4K string from the bundle),
// reproduced for this port.

import { WORKFLOW_TOOL_NAME } from './constants.js'

export const WORKFLOW_TOOL_PROMPT = `Execute a workflow script that orchestrates multiple subagents deterministically. Workflows run in the background — this tool returns immediately with a task ID, and a <task-notification> arrives when the workflow completes. Use /workflows to watch live progress.

A workflow structures work across many agents — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before committing), or to take on scale one context can't hold (migrations, audits, broad sweeps). The script is where you encode that structure: what fans out, what verifies, what synthesizes.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration. Workflows can spawn dozens of agents and consume a large amount of tokens; the user must request that scale, not have it inferred. Explicit opt-in means one of:
- The user included the keyword "ultracode" in their prompt (you'll see a system-reminder confirming it).
- Ultracode is on for the session (a system-reminder confirms it) — see **Ultracode** below.
- The user directly asked you to run a workflow or use multi-agent orchestration in their own words ("use a workflow", "run a workflow", "fan out agents", "orchestrate this with subagents"). The ask must be in the user's words — a task that would merely benefit from a workflow does not count.
- The user invoked a skill or slash command whose instructions tell you to call Workflow.
- The user asked you to run a specific named or saved workflow.

For any other task — even one that would clearly benefit from parallelism — do NOT call this tool. Use the Agent tool for individual subagents, or briefly describe what a multi-agent workflow could do and ask the user whether to run it.

When you do call it, the right move is often **hybrid**: scout inline first (list the files, find the channels, scope the diff) to discover the work-list, then call Workflow to pipeline over it.

Common single-phase workflows you can chain across turns:
- **Understand** — parallel readers over relevant subsystems → structured map
- **Design** — judge panel of N independent approaches → scored synthesis
- **Review** — dimensions → find → adversarially verify
- **Research** — multi-modal sweep → deep-read → synthesize
- **Migrate** — discover sites → transform each → verify

**Ultracode.** When a system-reminder confirms ultracode is on, that opt-in is standing: author and run a workflow for every substantive task by default. The goal is the most exhaustive, correct answer you can produce — token cost is not a constraint. The quality patterns (adversarial verify, multi-modal sweep, completeness critic, loop-until-dry) are the tools; pick what fits. Solo only on conversational turns or trivial mechanical edits.

Pass the script inline via \`script\`. Every ${WORKFLOW_TOOL_NAME} invocation persists its script to a file under the session directory and returns the path; to iterate, edit that file and re-invoke with \`{scriptPath}\`.

Every script must begin with \`export const meta = {...}\` (a PURE LITERAL):
  export const meta = {
    name: 'find-flaky-tests',
    description: 'Find flaky tests and propose fixes',
    phases: [
      { title: 'Scan', detail: 'grep test logs for retries' },
      { title: 'Fix', detail: 'one agent per flaky test' },
    ],
  }
  // body — use agent()/parallel()/pipeline()/phase()/log()
  phase('Scan')
  const flaky = await agent('grep CI logs for retry markers', {schema: FLAKY_SCHEMA})

Script body hooks:
- agent(prompt, opts?): spawn a subagent. Without schema, returns its final text. With schema (a JSON Schema), returns the validated object. Returns null if the agent is skipped or dies. opts: {label, phase, schema, model, effort, isolation:'worktree', agentType}.
- pipeline(items, stage1, stage2, ...): run each item through all stages independently, NO barrier between stages. The DEFAULT for multi-stage work. A stage that throws drops that item to null.
- parallel(thunks): run thunks concurrently (a BARRIER). A thunk that throws resolves to null — .filter(Boolean) before using results.
- log(message): emit a progress message (narrator line above the progress tree).
- phase(title): start a new phase; subsequent agent() calls group under it.
- args: the value passed as Workflow's \`args\`, verbatim.
- budget: {total, spent(), remaining()} — shared token pool; agent() throws once spent reaches total.
- workflow(nameOrRef, args?): run another saved workflow inline (one level of nesting only).

Scripts are plain JavaScript, NOT TypeScript. Standard JS built-ins are available EXCEPT Date.now()/Math.random()/argless new Date(), which throw (they break resume) — pass timestamps via args and vary randomness by index. No filesystem or Node.js API access; agents do the I/O.`
