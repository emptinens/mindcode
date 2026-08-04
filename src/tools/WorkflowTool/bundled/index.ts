// Registers the built-in workflows. Called once from tools.ts when
// WORKFLOW_SCRIPTS is enabled (mirrors initBundledWorkflows() in the bundle).

import { rememberBundledWorkflow } from '../registry.js'
import { CODE_REVIEW_SCRIPT } from './codeReview.js'
import { DEEP_RESEARCH_SCRIPT } from './deepResearch.js'

let initialized = false

export function initBundledWorkflows(): void {
  if (initialized) return
  initialized = true
  rememberBundledWorkflow(DEEP_RESEARCH_SCRIPT, {
    name: 'deep-research',
    description:
      'Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.',
    whenToUse:
      'When the user wants a deep, multi-source, fact-checked research report on any topic.',
  })
  rememberBundledWorkflow(CODE_REVIEW_SCRIPT, {
    name: 'code-review',
    description:
      'Adversarial code review — fan-out finders, independently verify each finding, synthesize a report.',
    whenToUse:
      'When the user wants a thorough multi-agent code review of a branch, PR, or set of changes.',
  })
}
