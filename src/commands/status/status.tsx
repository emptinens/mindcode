import type * as React from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import { Settings } from '../../components/Settings/Settings.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { generateStatusHtmlReport } from './report.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const mode = args.trim().toLowerCase()
  if (mode === '' || mode === 'html' || mode === 'report') {
    const path = await generateStatusHtmlReport()
    onDone(`Detailed status report generated: ${path}`, { display: 'system' })
    return null
  }
  if (mode === 'ui' || mode === 'panel') {
    return <Settings onClose={onDone} context={context} defaultTab="Status" />
  }
  onDone('Usage: /status [html|ui]', { display: 'system' })
  return null
}
