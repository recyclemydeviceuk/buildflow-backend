export interface LoginPayload {
  email: string
  password: string
}

export interface TokenPayload {
  sub: string
  role: string
  iat?: number
  exp?: number
}

export interface AuthResponse {
  accessToken: string
  refreshToken: string
  user: {
    id: string
    name: string
    email: string
    role: string
    avatarUrl?: string | null
  }
}

export interface RefreshTokenPayload {
  sub: string
  iat?: number
  exp?: number
}

export interface PasswordResetRequest {
  email: string
}

export interface PasswordReset {
  token: string
  newPassword: string
}
