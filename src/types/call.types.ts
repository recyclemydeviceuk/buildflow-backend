export interface InitiateCallPayload {
  leadId: string
  phone: string
}

export interface CallFeedbackPayload {
  outcome: string
  notes?: string
  interested?: boolean
  callBackAt?: string
  reason?: string
  stage?: string
}

export interface ExotelCallResponse {
  Call: {
    Sid: string
    Status: string
    From: string
    To: string
    Direction: string
    PhoneNumberSid: string
    StartTime?: string
    EndTime?: string
    Duration?: string
    RecordingUrl?: string
  }
}

export interface CallFilters {
  representative?: string
  lead?: string
  outcome?: string
  dateFrom?: string
  dateTo?: string
  page?: string
  limit?: string
}
