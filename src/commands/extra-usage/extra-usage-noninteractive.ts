import { runExtraUsage } from './extra-usage-core.js'

export async function call(): Promise<{ type: 'text'; value: string }> {
  const result = await runExtraUsage()

  if (result.type === 'message') {
    return { type: 'text', value: result.value }
  }

  if (result.type === 'admin-request-confirmation') {
    return {
      type: 'text',
      value:
        'Run /usage-credits in an interactive session to confirm sending a request to your organization admin.',
    }
  }

  return {
    type: 'text',
    value: result.opened
      ? `Browser opened to manage usage credits. If it didn't open, visit: ${result.url}`
      : `Please visit ${result.url} to manage usage credits.`,
  }
}
