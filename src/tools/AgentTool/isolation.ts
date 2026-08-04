/** Isolation requested directly on an Agent tool call. */
export type AgentIsolation = 'worktree' | 'remote'

export function validateAgentLocationOptions(
  cwd?: string,
  isolation?: AgentIsolation,
): void {
  if (cwd !== undefined && isolation !== undefined) {
    throw new Error('cwd and isolation are mutually exclusive')
  }
}

type PromptContentBlock = {
  type: string
  text?: string
}

/** User messages are persisted as either a plain string or content blocks. */
export function extractUserPromptText(
  content: string | readonly PromptContentBlock[],
): string {
  if (typeof content === 'string') return content
  return content
    .filter(
      (block): block is PromptContentBlock & { type: 'text'; text: string } =>
        block.type === 'text' && typeof block.text === 'string',
    )
    .map(block => block.text)
    .join('\n')
}

const WORKTREE_NEGATION_PATTERNS = [
  /\b(?:do\s+not|don't|dont|never|without)\b.{0,48}\b(?:git\s+)?work[\s-]?tree\b/i,
  /(?:не|без).{0,48}(?:worktree|ворктри|рабоч\p{L}*\s+дерев\p{L}*)/iu,
  /\b(?:cannot|can't|failed|fails|failure|error)\b.{0,80}\b(?:git\s+)?work[\s-]?tree\b/i,
  /(?:ошиб\p{L}*|не\s+удал\p{L}*|не\s+запуска\p{L}*).{0,80}(?:worktree|ворктри|рабоч\p{L}*\s+дерев\p{L}*)/iu,
]

const WORKTREE_REQUEST_PATTERNS = [
  /^\s*\/worktree\b/i,
  /\b(?:use|create|make|start|spawn|run|launch|put|move|isolate)\b.{0,80}\b(?:git\s+)?work[\s-]?tree\b/i,
  /\b(?:agent|worker|task|change|work)\b.{0,64}\b(?:in|inside|within|using|via)\s+(?:an?\s+)?(?:isolated\s+)?(?:git\s+)?work[\s-]?tree\b/i,
  /\b(?:use|create|make|start|spawn|run|launch|put|move|isolate)\b.{0,80}\b(?:isolated|separate)\s+(?:git\s+)?(?:repository|repo|checkout|workspace)\b/i,
  /(?:используй|использовать|создай|создать|запусти|запускать|работай|работать|помести|поместить|перенеси|перенести|изолируй|изолировать).{0,80}(?:worktree|ворктри|рабоч\p{L}*\s+дерев\p{L}*|(?:git[\s-]*)?репо\p{L}*|изолирован\p{L}*\s+(?:git[\s-]*)?(?:репо\p{L}*|ветк\p{L}*|рабоч\p{L}*\s+копи\p{L}*))/iu,
  /(?:агент\p{L}*|воркер\p{L}*|задач\p{L}*).{0,64}(?:в|через)\s+(?:отдельн\p{L}*\s+|изолирован\p{L}*\s+)?(?:git[\s-]*)?(?:worktree|ворктри|репо\p{L}*)/iu,
]

/**
 * Tool arguments are model-authored, so `isolation: "worktree"` is not by
 * itself proof of user intent. Require an imperative request in the current
 * human prompt and reject quoted errors, skill defaults, and agent metadata.
 */
export function hasExplicitWorktreeRequest(userPrompt?: string): boolean {
  if (!userPrompt) return false
  if (WORKTREE_NEGATION_PATTERNS.some(pattern => pattern.test(userPrompt))) {
    return false
  }
  return WORKTREE_REQUEST_PATTERNS.some(pattern => pattern.test(userPrompt))
}

/**
 * Agent definitions/frontmatter are descriptive metadata and must not change
 * the worker's execution directory. Worktree isolation additionally requires
 * an explicit request in the latest human-authored prompt.
 */
export function resolveAgentIsolation(
  explicitIsolation?: AgentIsolation,
  latestHumanPrompt?: string,
  isNestedAgent = false,
): AgentIsolation | undefined {
  if (explicitIsolation === 'worktree') {
    return !isNestedAgent && hasExplicitWorktreeRequest(latestHumanPrompt)
      ? 'worktree'
      : undefined
  }
  return explicitIsolation
}
