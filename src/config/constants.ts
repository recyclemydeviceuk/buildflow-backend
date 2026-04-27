export const NODE_ENV = process.env.NODE_ENV || 'development'
export const PORT = parseInt(process.env.PORT || '5000', 10)
export const APP_BASE_URL = process.env.APP_BASE_URL || 'https://api.buildflow.in'
export const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173'
export const CORS_ALLOWED_ORIGINS = Array.from(
  new Set(
    (process.env.CORS_ALLOWED_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
      .concat([FRONTEND_URL, 'https://divinehouse.in', 'https://www.divinehouse.in'])
  )
)

export const JWT_SECRET = process.env.JWT_SECRET!
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d'
export const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET!
export const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '30d'

export const BCRYPT_SALT_ROUNDS = 12

export const ROLES = {
  MANAGER: 'manager',
  REPRESENTATIVE: 'representative',
} as const

export const LEAD_SOURCES = ['Direct', 'Manual', 'Meta', 'Website', 'Google ADS'] as const

export const DISPOSITIONS = [
  'New',
  'Contacted/Open',
  'Qualified',
  'Visit Done',
  'Meeting Done',
  'Negotiation Done',
  'Booking Done',
  'Agreement Done',
  'Failed',
] as const

export const CALL_OUTCOMES = [
  'Connected',
  'Not Answered',
  'Busy',
  'Wrong Number',
  'Call Back Later',
  'Voicemail',
] as const

export const REMINDER_PRIORITIES = ['high', 'medium', 'low'] as const
export const REMINDER_STATUSES = ['upcoming', 'due_soon', 'overdue', 'completed'] as const

export const QUEUE_SEGMENTS = ['Unassigned', 'Timed Out', 'Skipped', 'Escalated'] as const

export const ROUTING_MODES = ['manual'] as const

export const LEAD_OFFER_TIMEOUT_DEFAULT_SEC = 60
export const LEAD_SKIP_LIMIT_DEFAULT = 3

export const IMPORT_MAX_FILE_SIZE_MB = 10
export const IMPORT_ALLOWED_MIME_TYPES = [
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]

export const S3_AVATARS_PREFIX = 'avatars/'
export const S3_IMPORTS_PREFIX = 'imports/'
export const S3_RECORDINGS_PREFIX = 'recordings/'

export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
export const RATE_LIMIT_MAX_REQUESTS = 200
export const AUTH_RATE_LIMIT_MAX = 20

// ── Timy AI (Gemini Live voice assistant) ──────────────────────────────────
// Gemini API key for the Live (speech-to-speech) endpoint. Set in .env as
// `GEMINI_API_KEY`. Required for Timy AI to function.
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''
// Live model used for speech-to-speech. Override per-environment via
// `GEMINI_LIVE_MODEL`. Defaults to Gemini 3.1 Flash Live preview — the
// closest publicly-listed match to "3.1 flash lite preview speech-to-speech"
// and confirmed via the v1beta ListModels API to support bidiGenerateContent.
// Other aliases known to support Live on v1beta:
//   gemini-3.1-flash-live-preview                       (DEFAULT — 3.1 preview)
//   gemini-2.5-flash-native-audio-latest                (2.5 native audio, rolling)
//   gemini-2.5-flash-native-audio-preview-12-2025       (2.5 native audio, dated)
// If your console shows "model is not found", run
//   curl https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY
// and pick a name whose `supportedGenerationMethods` includes
// `bidiGenerateContent`.
export const GEMINI_LIVE_MODEL =
  process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview'
// Gemini Live API version. Most production-ready Live models live on v1beta;
// only the very-early native-audio-dialog preview ever required v1alpha and
// that one has since been retired. Override via `GEMINI_LIVE_API_VERSION` if
// Google launches a new alpha-only preview.
export const GEMINI_LIVE_API_VERSION =
  process.env.GEMINI_LIVE_API_VERSION ||
  (/native-audio-dialog|preview-native/i.test(GEMINI_LIVE_MODEL) ? 'v1alpha' : 'v1beta')
