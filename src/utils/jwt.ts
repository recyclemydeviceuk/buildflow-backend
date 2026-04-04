import jwt from 'jsonwebtoken'
import {
  JWT_SECRET,
  JWT_EXPIRES_IN,
  JWT_REFRESH_SECRET,
  JWT_REFRESH_EXPIRES_IN,
} from '../config/constants'

export const signAccessToken = (userId: string, role: string): string =>
  jwt.sign({ sub: userId, role }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  } as jwt.SignOptions)

export const signRefreshToken = (userId: string): string =>
  jwt.sign({ sub: userId }, JWT_REFRESH_SECRET, {
    expiresIn: JWT_REFRESH_EXPIRES_IN,
  } as jwt.SignOptions)

export const verifyAccessToken = (token: string): jwt.JwtPayload =>
  jwt.verify(token, JWT_SECRET) as jwt.JwtPayload

export const verifyRefreshToken = (token: string): jwt.JwtPayload =>
  jwt.verify(token, JWT_REFRESH_SECRET) as jwt.JwtPayload
