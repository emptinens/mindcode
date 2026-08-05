/** Local compatibility boundary for the removed remote session-history API. */

import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'

export const HISTORY_PAGE_SIZE = 100

export type HistoryPage = {
  events: SDKMessage[]
  firstId: string | null
  hasMore: boolean
}

export type HistoryAuthCtx = {
  baseUrl: string
  headers: Record<string, string>
}

/** Return an inert context so existing callers remain non-blocking. */
export async function createHistoryAuthCtx(
  _sessionId: string,
): Promise<HistoryAuthCtx> {
  return { baseUrl: '', headers: {} }
}

/** Remote history is not available through the VEXZY endpoint contract. */
export async function fetchLatestEvents(
  _ctx: HistoryAuthCtx,
  _limit = HISTORY_PAGE_SIZE,
): Promise<HistoryPage | null> {
  return null
}

/** Remote history is not available through the VEXZY endpoint contract. */
export async function fetchOlderEvents(
  _ctx: HistoryAuthCtx,
  _beforeId: string,
  _limit = HISTORY_PAGE_SIZE,
): Promise<HistoryPage | null> {
  return null
}
