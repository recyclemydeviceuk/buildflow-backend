/**
 * Timy AI WebSocket relay.
 *
 * Browser  <─ ws ─>  this server  <─ ws ─>  Gemini Live (BidiGenerateContent)
 *
 * The browser never sees the Gemini API key. We authenticate the client via
 * the same JWT used by the REST API (passed as `?token=...` on the upgrade
 * request), then open an upstream connection to Gemini Live and pipe both
 * directions. When Gemini emits a `toolCall`, we resolve it locally with
 * MongoDB access and send a `toolResponse` back upstream.
 *
 * Wire format (browser <-> us):
 *   client → server :  { type: 'audio', data: <base64 16kHz PCM mono> }
 *                      { type: 'text',  data: '...' }
 *                      { type: 'audio_end' }                  (optional barge-in helper)
 *   server → client :  { type: 'ready' }                      handshake done
 *                      { type: 'setupComplete' }              Gemini accepted setup
 *                      { type: 'serverContent', data: ... }   pass-through Gemini payload
 *                      { type: 'toolCall', name, args }       (informational, for UI)
 *                      { type: 'error', message }
 */
import http from 'http'
import { URL } from 'url'
import WebSocket, { WebSocketServer, RawData } from 'ws'
import jwt from 'jsonwebtoken'
import {
  JWT_SECRET,
  GEMINI_API_KEY,
  GEMINI_LIVE_MODEL,
  GEMINI_LIVE_API_VERSION,
} from '../../config/constants'
import { User } from '../../models/User'
import { logger } from '../../utils/logger'
import {
  buildTimySystemPrompt,
  getTimyToolDeclarations,
  runTimyTool,
  TimyContext,
} from './timyTools'

const GEMINI_LIVE_URL = (apiKey: string) =>
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${GEMINI_LIVE_API_VERSION}.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(
    apiKey
  )}`

// Per-language prebuilt voice selection. All three voices come from
// Gemini's multilingual prebuilt set — `languageCode` does the heavy
// lifting, the voiceName just picks the timbre. Each can be overridden
// via env without redeploy (e.g. GEMINI_VOICE_KN_IN=Leda).
const VOICE_BY_LANGUAGE: Record<'en-IN' | 'hi-IN' | 'kn-IN', string> = {
  'en-IN': process.env.GEMINI_VOICE_EN_IN || 'Aoede',  // warm female, Indian English
  'hi-IN': process.env.GEMINI_VOICE_HI_IN || 'Charon', // deep male, Hindi
  'kn-IN': process.env.GEMINI_VOICE_KN_IN || 'Kore',   // crisp female, Kannada
}

const TIMY_PATH = '/ws/timy'

export const initTimyWebSocketServer = (httpServer: http.Server): void => {
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', async (req, socket, head) => {
    if (!req.url) return
    let pathname: string
    try {
      pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname
    } catch {
      return
    }
    // Only handle our path. socket.io / others get untouched.
    if (pathname !== TIMY_PATH) return

    if (!GEMINI_API_KEY) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
      socket.destroy()
      return
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const token = url.searchParams.get('token') || ''
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    // Validate the requested voice language. Falls back to Indian English
    // if the client sends anything we don't recognise.
    const ALLOWED_LANGS = ['en-IN', 'hi-IN', 'kn-IN'] as const
    const langParam = (url.searchParams.get('lang') || 'en-IN') as (typeof ALLOWED_LANGS)[number]
    const language: 'en-IN' | 'hi-IN' | 'kn-IN' = (ALLOWED_LANGS as readonly string[]).includes(
      langParam
    )
      ? langParam
      : 'en-IN'

    // Optional conversation history — base64(json) of `[{role, text}, ...]`.
    // Sent by the browser on reconnect (e.g. language switch) so the new
    // upstream session can splice the prior turns into its system prompt and
    // continue the chat instead of starting fresh.
    let history: Array<{ role: 'user' | 'assistant'; text: string }> = []
    const historyParam = url.searchParams.get('history') || ''
    if (historyParam) {
      try {
        const json = Buffer.from(historyParam, 'base64').toString('utf-8')
        const parsed = JSON.parse(json)
        if (Array.isArray(parsed)) {
          history = parsed
            .filter(
              (e: any) =>
                e &&
                (e.role === 'user' || e.role === 'assistant') &&
                typeof e.text === 'string'
            )
            .slice(-12) // hard cap so a malicious client can't blow up the prompt
        }
      } catch {
        // ignore — bad input just means no history
      }
    }

    let ctx: TimyContext
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload
      const user = await User.findById(decoded.sub).select('name role isActive isDemo')
      if (!user || !user.isActive) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      ctx = {
        userId: String(user._id),
        userName: user.name,
        userRole: user.role,
        isDemo: Boolean(user.isDemo),
        language,
        history,
      }
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      attachTimySession(clientWs, ctx)
    })
  })

  logger.info('Timy WebSocket server attached', {
    path: TIMY_PATH,
    model: GEMINI_LIVE_MODEL,
    apiVersion: GEMINI_LIVE_API_VERSION,
    keyConfigured: Boolean(GEMINI_API_KEY),
  })
}

// Build a one-line, user-facing summary of a tool result for the activity
// card. Kept here (not in timyTools) because the shape is purely a UI concern.
const summarizeToolResult = (
  name: string,
  args: Record<string, any>,
  result: any,
  ok: boolean
): string => {
  if (!ok) {
    if (result && typeof result === 'object' && typeof result.error === 'string') {
      return result.error
    }
    return 'Failed'
  }
  if (!result || typeof result !== 'object') return 'Done'
  switch (name) {
    case 'find_lead':
    case 'list_recent_leads':
      return typeof result.count === 'number'
        ? `${result.count} ${result.count === 1 ? 'lead' : 'leads'}`
        : 'Done'
    case 'count_leads_by_disposition':
      return typeof result.total === 'number' ? `${result.total} leads grouped` : 'Done'
    case 'get_today_followups':
      return typeof result.count === 'number'
        ? `${result.count} due today`
        : 'Done'
    case 'get_overdue_followups':
      return typeof result.count === 'number'
        ? `${result.count} overdue`
        : 'Done'
    case 'get_my_recent_calls':
      return typeof result.count === 'number'
        ? `${result.count} ${result.count === 1 ? 'call' : 'calls'}`
        : 'Done'
    case 'get_team_overview':
      return Array.isArray(result.reps) ? `${result.reps.length} reps` : 'Done'
    case 'find_team_member':
      return typeof result.count === 'number' ? `${result.count} matches` : 'Done'
    case 'get_my_pipeline_summary':
      if (typeof result.leadsOwned === 'number') {
        return `${result.leadsOwned} leads · ${result.followUpsDueToday} today · ${result.overdueFollowUps} overdue`
      }
      return 'Done'
    case 'create_lead':
      return result.name ? `Created ${result.name}` : 'Lead created'
    case 'update_lead_disposition':
      return result.disposition ? `Set to ${result.disposition}` : 'Status updated'
    case 'add_lead_note':
      return 'Note added'
    case 'assign_lead':
      return result.assignedTo ? `Assigned to ${result.assignedTo}` : 'Unassigned'
    case 'delete_lead':
      return result.deletedLeadName ? `Deleted ${result.deletedLeadName}` : 'Lead deleted'
    case 'schedule_followup':
      if (result.scheduledAt) {
        const d = new Date(result.scheduledAt)
        return `Scheduled · ${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`
      }
      return 'Follow-up scheduled'
    case 'complete_followup':
      return 'Marked done'
    case 'cancel_followup':
      return 'Cancelled'
    case 'set_rep_lead_receiving':
      return result.acceptingNewLeads
        ? `${result.name} accepting leads`
        : `${result.name} blocked from new leads`
    case 'set_my_availability':
      return result.status === 'offline' ? 'You are offline' : 'You are available'
    case 'switch_language':
      return result.language ? `Switching to ${result.language}` : 'Language switched'
    default:
      return 'Done'
  }
}

const attachTimySession = (clientWs: WebSocket, ctx: TimyContext): void => {
  let upstream: WebSocket | null = null
  let setupComplete = false
  let closed = false

  const safeClientSend = (payload: unknown) => {
    if (clientWs.readyState !== WebSocket.OPEN) return
    try {
      clientWs.send(typeof payload === 'string' ? payload : JSON.stringify(payload))
    } catch (err) {
      logger.warn('Timy: failed to send to client', err)
    }
  }

  const closeAll = (code = 1000, reason = '') => {
    if (closed) return
    closed = true
    try {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close(code, reason)
    } catch {}
    try {
      if (upstream && upstream.readyState === WebSocket.OPEN) upstream.close()
    } catch {}
  }

  // ── Open upstream Gemini Live socket ────────────────────────────────────
  try {
    upstream = new WebSocket(GEMINI_LIVE_URL(GEMINI_API_KEY))
  } catch (err) {
    logger.error('Timy: failed to open Gemini Live socket', err)
    safeClientSend({ type: 'error', message: 'Could not reach Gemini Live.' })
    closeAll()
    return
  }

  // Upstream upgrade failure (e.g. 4xx from the Gemini API) — `ws` emits
  // `unexpected-response` instead of `error`. Capture the body so we can tell
  // the user *why* (invalid key, model not enabled, region restricted, etc.).
  upstream.on('unexpected-response', (_req, res) => {
    let body = ''
    res.on('data', (chunk) => (body += chunk.toString()))
    res.on('end', () => {
      const trimmed = body.slice(0, 400)
      logger.error('Timy: upstream unexpected response', {
        status: res.statusCode,
        body: trimmed,
      })
      safeClientSend({
        type: 'error',
        message: `Gemini rejected the connection (HTTP ${res.statusCode}). ${trimmed}`,
      })
      closeAll()
    })
  })

  upstream.on('open', () => {
    logger.info('Timy: upstream open', {
      user: ctx.userId,
      apiVersion: GEMINI_LIVE_API_VERSION,
      model: GEMINI_LIVE_MODEL,
      language: ctx.language,
      voice: VOICE_BY_LANGUAGE[ctx.language],
    })
    const setup: any = {
      setup: {
        model: `models/${GEMINI_LIVE_MODEL}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            // Female Indian-English voice for en-IN, deep male voice for
            // hi-IN. Both come from Gemini's multilingual prebuilt set so
            // the same model serves both with no extra config.
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: VOICE_BY_LANGUAGE[ctx.language] },
            },
            languageCode: ctx.language,
          },
        },
        systemInstruction: {
          parts: [{ text: buildTimySystemPrompt(ctx) }],
        },
        tools: [{ functionDeclarations: getTimyToolDeclarations(ctx.userRole) }],
      },
    }
    // Transcription fields are only on v1alpha right now. Adding them to a
    // v1beta setup makes the upstream reject the entire payload.
    if (GEMINI_LIVE_API_VERSION === 'v1alpha') {
      setup.setup.outputAudioTranscription = {}
      setup.setup.inputAudioTranscription = {}
    }
    try {
      upstream!.send(JSON.stringify(setup))
      safeClientSend({ type: 'ready' })
    } catch (err) {
      logger.error('Timy: failed to send setup', err)
      safeClientSend({ type: 'error', message: 'Setup failed.' })
      closeAll()
    }
  })

  upstream.on('message', async (raw: RawData) => {
    let msg: any
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.setupComplete) {
      setupComplete = true
      safeClientSend({ type: 'setupComplete' })
      // Nudge Gemini to greet first. Without this, Live mode silently waits
      // for the user to speak, which feels broken when they just opened the
      // panel. Skip on history-bearing reconnects (language switch) — the
      // prompt already tells the model not to re-greet there.
      if (!ctx.history || ctx.history.length === 0) {
        try {
          upstream?.send(
            JSON.stringify({
              clientContent: {
                turns: [{ role: 'user', parts: [{ text: '<<session_start>>' }] }],
                turnComplete: true,
              },
            })
          )
        } catch (err) {
          logger.warn('Timy: failed to send session-start nudge', err)
        }
      }
      return
    }

    if (msg.serverContent) {
      safeClientSend({ type: 'serverContent', data: msg.serverContent })
    }

    if (msg.toolCall) {
      const calls: any[] = msg.toolCall.functionCalls || []
      const responses: any[] = []
      for (const fc of calls) {
        const callId = fc.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const startedAt = Date.now()
        // toolStart kicks off the activity card in the UI immediately so the
        // user sees what Timy is doing before the (potentially slow) handler
        // resolves.
        safeClientSend({
          type: 'toolStart',
          id: callId,
          name: fc.name,
          args: fc.args || {},
        })
        try {
          const result = await runTimyTool(fc.name, fc.args || {}, ctx)
          responses.push({
            id: fc.id,
            name: fc.name,
            response: { output: result },
          })
          const ok = !(result && typeof result === 'object' && 'error' in result)
          safeClientSend({
            type: 'toolResult',
            id: callId,
            name: fc.name,
            ok,
            summary: summarizeToolResult(fc.name, fc.args || {}, result, ok),
            durationMs: Date.now() - startedAt,
          })
          // Intercept: when the model decides to switch language, tell the
          // browser to flip its UI toggle and reconnect in the new language.
          // The actual voice only changes on a fresh upstream session because
          // speechConfig.languageCode + voiceConfig are bound at setup time.
          if (fc.name === 'switch_language') {
            const target =
              fc.args?.language === 'hi-IN'
                ? 'hi-IN'
                : fc.args?.language === 'kn-IN'
                ? 'kn-IN'
                : 'en-IN'
            safeClientSend({ type: 'language_switch', language: target })
          }
        } catch (err: any) {
          logger.error('Timy: tool execution failed', { name: fc.name, err: err?.message })
          responses.push({
            id: fc.id,
            name: fc.name,
            response: { error: err?.message || 'Tool failed' },
          })
          safeClientSend({
            type: 'toolResult',
            id: callId,
            name: fc.name,
            ok: false,
            summary: err?.message || 'Tool failed',
            durationMs: Date.now() - startedAt,
          })
        }
      }
      try {
        upstream?.send(JSON.stringify({ toolResponse: { functionResponses: responses } }))
      } catch (err) {
        logger.error('Timy: failed to send toolResponse', err)
      }
    }

    if (msg.toolCallCancellation) {
      safeClientSend({ type: 'toolCallCancellation', data: msg.toolCallCancellation })
    }
  })

  upstream.on('close', (code, reason) => {
    const reasonStr = reason?.toString() || ''
    logger.warn('Timy: upstream closed', {
      user: ctx.userId,
      code,
      reason: reasonStr,
      setupComplete,
    })
    // If the upstream closed before setupComplete, that almost always means
    // Gemini rejected our setup payload (bad model name, wrong API version,
    // unsupported field). Surface a concrete reason to the browser so the
    // user doesn't just see "Session ended".
    const message = setupComplete
      ? reasonStr || `Gemini Live closed the connection (code ${code}).`
      : reasonStr
        ? `Gemini Live rejected the session: ${reasonStr}`
        : `Gemini Live rejected the session before setup completed (code ${code}). Check that GEMINI_LIVE_MODEL "${GEMINI_LIVE_MODEL}" is available on your API key and that GEMINI_LIVE_API_VERSION (${GEMINI_LIVE_API_VERSION}) matches the model.`
    safeClientSend({ type: 'error', message })
    safeClientSend({ type: 'upstream_closed', code, reason: reasonStr })
    closeAll(1000)
  })

  upstream.on('error', (err: any) => {
    logger.error('Timy: upstream error', { message: err?.message || String(err) })
    safeClientSend({
      type: 'error',
      message: `Upstream connection error: ${err?.message || 'unknown'}.`,
    })
    closeAll()
  })

  // ── Pipe client → upstream ──────────────────────────────────────────────
  clientWs.on('message', (raw: RawData) => {
    if (!setupComplete || !upstream || upstream.readyState !== WebSocket.OPEN) return
    let msg: any
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type === 'audio' && typeof msg.data === 'string') {
      // Base64 little-endian 16-bit PCM @ 16kHz mono from the browser.
      // The newer Live API takes a single `audio` field; the legacy
      // `mediaChunks` array is deprecated and the server emits a warning
      // back to the client when used.
      try {
        upstream.send(
          JSON.stringify({
            realtimeInput: {
              audio: { mimeType: 'audio/pcm;rate=16000', data: msg.data },
            },
          })
        )
      } catch (err) {
        logger.warn('Timy: failed to forward audio chunk', err)
      }
    } else if (msg.type === 'text' && typeof msg.data === 'string') {
      try {
        upstream.send(
          JSON.stringify({
            clientContent: {
              turns: [{ role: 'user', parts: [{ text: msg.data }] }],
              turnComplete: true,
            },
          })
        )
      } catch (err) {
        logger.warn('Timy: failed to forward text', err)
      }
    }
    // Ignore anything else — keeps protocol forward-compatible.
  })

  clientWs.on('close', () => closeAll())
  clientWs.on('error', () => closeAll())
}
