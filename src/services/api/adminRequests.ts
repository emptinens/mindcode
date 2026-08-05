/** Local compatibility API for the removed organization-admin endpoints. */

export type AdminRequestType = 'limit_increase' | 'seat_upgrade'

export type AdminRequestStatus = 'pending' | 'approved' | 'dismissed'

export type AdminRequestSeatUpgradeDetails = {
  message?: string | null
  current_seat_tier?: string | null
}

export type AdminRequestCreateParams =
  | {
      request_type: 'limit_increase'
      details: null
    }
  | {
      request_type: 'seat_upgrade'
      details: AdminRequestSeatUpgradeDetails
    }

export type AdminRequest = {
  uuid: string
  status: AdminRequestStatus
  requester_uuid?: string | null
  created_at: string
} & (
  | {
      request_type: 'limit_increase'
      details: null
    }
  | {
      request_type: 'seat_upgrade'
      details: AdminRequestSeatUpgradeDetails
    }
)

/** The removed remote operation is represented as a local unavailable error. */
export async function createAdminRequest(
  _params: AdminRequestCreateParams,
): Promise<AdminRequest> {
  throw new Error('Organization admin requests are unavailable in VEXZY mode')
}

/** No remote request state exists locally. */
export async function getMyAdminRequests(
  _requestType: AdminRequestType,
  _statuses: AdminRequestStatus[],
): Promise<AdminRequest[] | null> {
  return []
}

type AdminRequestEligibilityResponse = {
  request_type: AdminRequestType
  is_allowed: boolean
}

/** No organization-admin request can be created through the VEXZY boundary. */
export async function checkAdminRequestEligibility(
  requestType: AdminRequestType,
): Promise<AdminRequestEligibilityResponse | null> {
  return { request_type: requestType, is_allowed: false }
}
