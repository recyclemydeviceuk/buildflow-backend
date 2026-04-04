export interface ExotelCallStatusPayload {
  EventType?: string
  CallSid: string
  Status: string
  DialCallStatus?: string
  DialCallDuration?: string
  Duration?: string
  ConversationDuration?: string | number
  RecordingUrl?: string
  StartTime?: string
  EndTime?: string
  From?: string
  To?: string
  Direction?: string
}

export interface ExotelV3StatusCallbackConfig {
  event: 'answered' | 'terminal'
  url: string
  method?: 'GET' | 'POST'
  content_type?: 'application/json' | 'multipart/form-data'
}

export interface ExotelV3CreateCallParams {
  from: {
    contact_uri: string
    state_management?: boolean
  }
  to: {
    contact_uri: string
  }
  virtual_number: string
  recording?: {
    record?: boolean
    channels?: 'single' | 'dual'
    format?: 'mp3' | 'mp3-hq'
  }
  attempt_time_out?: number
  max_time_limit?: number
  custom_field?: string
  wait_audio_url?: string
  status_callback?: ExotelV3StatusCallbackConfig[]
}

export interface ExotelV3CallDetails {
  sid: string
  direction?: string
  virtual_number?: string
  state?: 'active' | 'terminal'
  status?: string | null
  legs?: string | null
  created_time?: string
  updated_time?: string
  start_time?: string | null
  end_time?: string | null
  total_duration?: number | null
  total_talk_time?: number | null
  custom_field?: string | null
  recordings?: Array<{ url: string }> | null
}

export interface ExotelV3CreateCallResponse {
  request_id: string
  method: string
  http_code: number
  response: {
    code: number
    status: 'success' | 'failure'
    error_data?: {
      code?: number
      description?: string
      message?: string
    } | null
    call_details?: ExotelV3CallDetails | null
  }
}

export interface ExotelV3StatusCallbackPayload {
  event_details: {
    event_type: 'answered' | 'terminal'
  }
  call_details: ExotelV3CallDetails
}

export interface ExotelOutboundCallParams {
  From: string
  To: string
  CallerId: string
  StatusCallback?: string
  StatusCallbackContentType?: 'application/json' | 'multipart/form-data'
  StatusCallbackEvents?: string[]
  Record?: string
  RecordingChannels?: string
  TimeLimit?: number
  TimeOut?: number
}

export interface ExotelSMSParams {
  From: string
  To: string
  Body: string
  StatusCallback?: string
  EncodingType?: string
  CustomField?: string
  DltEntityId?: string
  DltTemplateId?: string
  SmsType?: 'transactional' | 'transactional_opt_in' | 'promotional'
  Priority?: 'normal' | 'high'
}

export interface ExotelSMSResponse {
  SMSMessage?: {
    Sid?: string
    Status?: string
    DetailedStatus?: string
    DetailedStatusCode?: string
    DateCreated?: string
    DateSent?: string
    To?: string
    From?: string
    Body?: string
    Uri?: string
  }
  SmsMessage?: {
    Sid?: string
    Status?: string
    DetailedStatus?: string
    DetailedStatusCode?: string
    DateCreated?: string
    DateSent?: string
    To?: string
    From?: string
    Body?: string
    Uri?: string
  }
}

export interface ExotelSMSStatusCallbackPayload {
  SmsSid?: string
  To?: string
  Status?: 'queued' | 'sending' | 'submitted' | 'sent' | 'failed-dnd' | 'failed'
  SmsUnits?: string
  DetailedStatus?: string
  DetailedStatusCode?: string
  DateSent?: string
  CustomField?: string
}

export interface ExotelCallResponse {
  Call: {
    Sid: string
    Status: string
    DateCreated?: string
    DateUpdated?: string
    From: string
    To: string
    Direction: string
    PhoneNumberSid: string
    StartTime?: string
    EndTime?: string
    Duration?: string
    DialCallDuration?: string
    RecordingUrl?: string
  }
}

export interface ExotelBulkCall {
  Sid: string
  ParentCallSid?: string | null
  DateCreated?: string
  DateUpdated?: string
  AccountSid?: string
  To?: string
  From?: string
  PhoneNumber?: string
  PhoneNumberSid?: string
  Status?: string
  StartTime?: string
  EndTime?: string | null
  Duration?: string | number | null
  Price?: string | number | null
  Direction?: string
  AnsweredBy?: string | null
  ForwardedFrom?: string | null
  CallerName?: string | null
  CustomField?: string | null
  Uri?: string
  RecordingUrl?: string | null
}

export interface ExotelBulkCallListResponse {
  Metadata?: {
    Total?: number
    PageSize?: number
    FirstPageUri?: string
    NextPageUri?: string | null
    PrevPageUri?: string | null
  }
  Calls: ExotelBulkCall[]
}

export interface ExoVoiceAnalyzeWebhookPayload {
  success: boolean
  reason?: string
  task_id?: string
  job_id: string
  callSID: string
  summary?: {
    summary: string
    confidence: number
  }
  sentiment?: {
    sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'
    confidence: number
  }
  category?: {
    category: string
    confidence: number
  }
  transcript?: string
}

export interface ExotelAccountDetails {
  Sid: string
  FriendlyName: string
  Status: string
  Type: string
  CurrentBalance: string
  Currency: string
}
