import type * as React from 'react'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../commands.js'
import { Text } from '../../ink.js'

/** Provider subscription upgrades are not part of the VEXZY runtime. */
export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
): Promise<React.ReactNode | null> {
  setTimeout(onDone, 0, 'VEXZY uses API-key access; no subscription upgrade is required.')
  return <Text>VEXZY API access is configured outside MindCode.</Text>
}
