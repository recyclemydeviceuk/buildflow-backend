export interface CreateLeadPayload {
  name: string
  phone: string
  email?: string
  city: string
  source: string
  budget?: string
  plotSize?: number
  plotSizeUnit?: string
  plotOwned?: boolean
  buildType?: string
  campaign?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmTerm?: string
  utmContent?: string
  notes?: string
  tags?: string[]
}

export interface UpdateLeadPayload extends Partial<CreateLeadPayload> {
  disposition?: string
  lastActivityNote?: string
}

export interface LeadFilters {
  search?: string
  source?: string
  disposition?: string
  owner?: string
  city?: string
  dateFrom?: string
  dateTo?: string
  isInQueue?: boolean
  page?: string
  limit?: string
  sort?: string
}

export interface AssignLeadPayload {
  userId: string
}

export interface UpdateDispositionPayload {
  disposition: string
  note?: string
}

export interface AddStatusNotePayload {
  status: string
  note: string
}
