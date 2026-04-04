import { Server as HTTPServer } from 'http'
import { Server as SocketIOServer, Socket } from 'socket.io'
import { FRONTEND_URL } from './constants'

export interface UserAvailabilityPayload {
  id: string
  name: string
  email?: string
  role: 'manager' | 'representative'
  phone?: string | null
  callAvailabilityStatus: 'available' | 'offline' | 'in-call'
  callDeviceMode?: 'phone' | 'web'
  activeCallSid?: string | null
  isActive?: boolean
}

let io: SocketIOServer

export const initSocket = (httpServer: HTTPServer): SocketIOServer => {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: FRONTEND_URL,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  })

  io.on('connection', (socket: Socket) => {
    console.log(`Socket connected: ${socket.id}`)

    socket.on('join:user', (userId: string) => {
      socket.join(`user:${userId}`)
    })

    socket.on('join:team', (teamId: string) => {
      socket.join(`team:${teamId}`)
    })

    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`)
    })
  })

  return io
}

export const getIO = (): SocketIOServer => {
  if (!io) {
    throw new Error('Socket.IO has not been initialized. Call initSocket first.')
  }
  return io
}

export const emitToUser = (userId: string, event: string, data: unknown): void => {
  if (!io) return
  getIO().to(`user:${userId}`).emit(event, data)
}

export const emitToTeam = (teamId: string, event: string, data: unknown): void => {
  if (!io) return
  getIO().to(`team:${teamId}`).emit(event, data)
}

export const emitToAll = (event: string, data: unknown): void => {
  if (!io) return
  getIO().emit(event, data)
}

export const emitUserAvailabilityUpdate = (data: UserAvailabilityPayload): void => {
  emitToUser(data.id, 'user:availability_updated', data)
  emitToTeam('all', 'user:availability_updated', data)
}
