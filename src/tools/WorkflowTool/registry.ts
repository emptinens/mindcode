// Workflow registry + resolver.
//
// Resolution order for a workflow `name`:
//   1. bundled (built-in: deep-research, code-review)
//   2. project: <cwd>/.mindcode/workflows/*.js
//   3. user:    <config>/.mindcode/workflows/*.js  (MINDCODE_CONFIG_DIR or ~/.mindcode)
//
// Inline scripts (passed via `script`) bypass the registry entirely.

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getCwd } from '../../utils/cwd.js'
import { WORKFLOW_SCRIPT_MAX_BYTES } from './constants.js'
import { parseWorkflowScript, type WorkflowPhase } from './meta.js'

export type WorkflowSource = 'built-in' | 'projectSettings' | 'userSettings'

export type WorkflowEntry = {
  source: WorkflowSource
  name: string
  description: string
  whenToUse?: string
  phases?: WorkflowPhase[]
  script: string
  filePath?: string
  hidden?: boolean
}

const bundled: WorkflowEntry[] = []

/** Register a bundled (built-in) workflow. Called by bundled/index.ts. */
export function rememberBundledWorkflow(
  script: string,
  meta: { name: string; description: string; whenToUse?: string },
  opts?: { hidden?: boolean },
): void {
  const parsed = parseWorkflowScript(script)
  const phases = 'meta' in parsed ? parsed.meta.phases : undefined
  bundled.push({
    source: 'built-in',
    name: meta.name,
    description: meta.description,
    whenToUse: meta.whenToUse,
    phases,
    script,
    hidden: opts?.hidden,
  })
}

function userWorkflowsDir(): string {
  const base = process.env.MINDCODE_CONFIG_DIR
    ? process.env.MINDCODE_CONFIG_DIR
    : join(homedir(), '.mindcode')
  return join(base, 'workflows')
}

function projectWorkflowsDir(): string {
  return join(getCwd(), '.mindcode', 'workflows')
}

function loadDir(dir: string, source: WorkflowSource): WorkflowEntry[] {
  let names: string[]
  try {
    if (!existsSync(dir)) return []
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: WorkflowEntry[] = []
  for (const fileName of names) {
    if (!fileName.endsWith('.js')) continue
    const filePath = join(dir, fileName)
    try {
      if (statSync(filePath).size > WORKFLOW_SCRIPT_MAX_BYTES) continue
      const script = readFileSync(filePath, 'utf-8')
      const parsed = parseWorkflowScript(script)
      if ('error' in parsed) continue
      out.push({
        source,
        name: parsed.meta.name,
        description: parsed.meta.description,
        whenToUse: parsed.meta.whenToUse,
        phases: parsed.meta.phases,
        script,
        filePath,
      })
    } catch {
      // skip unreadable/invalid files
    }
  }
  return out
}

/** All available workflows (bundled + project + user), de-duplicated by name. */
export function listWorkflows(): WorkflowEntry[] {
  const byName = new Map<string, WorkflowEntry>()
  for (const e of bundled) if (!e.hidden) byName.set(e.name, e)
  // project/user override bundled of the same name
  for (const e of loadDir(userWorkflowsDir(), 'userSettings')) byName.set(e.name, e)
  for (const e of loadDir(projectWorkflowsDir(), 'projectSettings'))
    byName.set(e.name, e)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function resolveWorkflowByName(name: string): WorkflowEntry | undefined {
  return listWorkflows().find(w => w.name === name)
}
