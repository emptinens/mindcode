export function buildSwarmTmuxArgs(
  socketName: string,
  args: readonly string[],
): string[] {
  return ['-L', socketName, ...args]
}

export function allocateUniqueTeammateName(
  baseName: string,
  existingNames: Iterable<string>,
): string {
  const normalized = new Set(
    Array.from(existingNames, name => name.toLowerCase()),
  )
  if (!normalized.has(baseName.toLowerCase())) return baseName

  let suffix = 2
  while (normalized.has(`${baseName}-${suffix}`.toLowerCase())) suffix++
  return `${baseName}-${suffix}`
}

export function upsertMemberByAgentId<T extends { agentId: string }>(
  members: readonly T[],
  member: T,
): T[] {
  const index = members.findIndex(current => current.agentId === member.agentId)
  if (index === -1) return [...members, member]
  const updated = [...members]
  updated[index] = member
  return updated
}
