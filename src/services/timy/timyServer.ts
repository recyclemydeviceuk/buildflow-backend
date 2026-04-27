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
import { JWT_SECRET, GEMINI_API_KEY, GEMINI_LIVE_MODEL } from '../../config/constants'
import { User } from '../../models/User'
import { logger } from '../../utils/logger'
import {
  buildTimySystemPrompt,
  getTimyToolDeclarations,
  runTimyTool,
  TimyContext,
} from './timyTools'

const GEMINI_LIVE_URL = (apiKey: string) =>
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(
    apiKey
  )}`

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

  logger.info('Timy WebSocket server attached', { path: TIMY_PATH, model: GEMINI_LIVE_MODEL })
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

  upstream.on('open', () => {
    const setup = {
      setup: {
        model: `models/${GEMINI_LIVE_MODEL}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } },
          },
        },
        systemInstruction: {
          parts: [{ text: buildTimySystemPrompt(ctx) }],
        },
        tools: [{ functionDeclarations: getTimyToolDeclarations(ctx.userRole) }],
        // Ask Gemini to also send transcripts so the UI can show captions.
        outputAudioTranscription: {},
        inputAudioTranscription: {},
      },
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
      return
    }

    if (msg.serverContent) {
      safeClientSend({ type: 'serverContent', data: msg.serverContent })
    }

    if (msg.toolCall) {
      const calls: any[] = msg.toolCall.functionCalls || []
      const responses: any[] = []
      for (const fc of calls) {
        safeClientSend({ type: 'toolCall', name: fc.name, args: fc.args })
        try {
          const result = await runTimyTool(fc.name, fc.args || {}, ctx)
          responses.push({
            id: fc.id,
            name: fc.name,
            response: { output: result },
          })
        } catch (err: any) {
          logger.error('Timy: tool execution failed', { name: fc.name, err: err?.message })
          responses.push({
            id: fc.id,
            name: fc.name,
            response: { error: err?.message || 'Tool failed' },
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
    safeClientSend({ type: 'upstream_closed', code, reason: reason?.toString() })
    closeAll(1000)
  })

  upstream.on('error', (err: any) => {
    logger.error('Timy: upstream error', err?.message || err)
    safeClientSend({ type: 'error', message: 'Upstream connection error.' })
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
      // Base64 little-endian 16-bit PCM @ 16kHz mono from the browser
      try {
        upstream.send(
          JSON.stringify({
            realtimeInput: {
              mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: msg.data }],
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
