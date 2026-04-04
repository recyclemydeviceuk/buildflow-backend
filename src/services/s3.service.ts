import axios from 'axios'
import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { s3Client, S3_BUCKET_NAME, S3_ENDPOINT, S3_PROVIDER, S3_PUBLIC_BASE_URL, S3_REGION } from '../config/aws'
import { logger } from '../utils/logger'

const trimSlashes = (value: string) => value.replace(/\/+$/, '')

export const buildStorageObjectUrl = (key: string): string => {
  if (S3_PUBLIC_BASE_URL) {
    return `${trimSlashes(S3_PUBLIC_BASE_URL)}/${key}`
  }

  if (S3_PROVIDER === 'r2' && S3_ENDPOINT && S3_BUCKET_NAME) {
    return `${trimSlashes(S3_ENDPOINT)}/${S3_BUCKET_NAME}/${key}`
  }

  if (S3_REGION && S3_REGION !== 'auto') {
    return `https://${S3_BUCKET_NAME}.s3.${S3_REGION}.amazonaws.com/${key}`
  }

  return `https://${S3_BUCKET_NAME}.s3.amazonaws.com/${key}`
}

export const uploadToS3 = async (
  key: string,
  body: Buffer,
  contentType: string,
  isPublic = false
): Promise<string | null> => {
  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(isPublic ? { CacheControl: 'public, max-age=31536000, immutable' } : {}),
      })
    )
    return buildStorageObjectUrl(key)
  } catch (err) {
    logger.error('S3 uploadToS3 error', err)
    return null
  }
}

export const deleteFromS3 = async (key: string): Promise<boolean> => {
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET_NAME, Key: key }))
    return true
  } catch (err) {
    logger.error('S3 deleteFromS3 error', err)
    return false
  }
}

export const getPresignedUrl = async (key: string, expiresIn = 3600): Promise<string | null> => {
  try {
    const command = new GetObjectCommand({ Bucket: S3_BUCKET_NAME, Key: key })
    return await getSignedUrl(s3Client, command, { expiresIn })
  } catch (err) {
    logger.error('S3 getPresignedUrl error', err)
    return null
  }
}

export const getS3KeyFromUrl = (url: string): string | null => {
  if (!url) return null

  if (S3_PUBLIC_BASE_URL) {
    const normalizedBase = `${trimSlashes(S3_PUBLIC_BASE_URL)}/`
    if (url.startsWith(normalizedBase)) {
      return url.slice(normalizedBase.length)
    }
  }

  const awsMatch = url.match(/\.amazonaws\.com\/(.+)$/)
  if (awsMatch) return awsMatch[1]

  if (S3_ENDPOINT && S3_BUCKET_NAME) {
    const normalizedEndpointPrefix = `${trimSlashes(S3_ENDPOINT)}/${S3_BUCKET_NAME}/`
    if (url.startsWith(normalizedEndpointPrefix)) {
      return url.slice(normalizedEndpointPrefix.length)
    }
  }

  try {
    const parsedUrl = new URL(url)
    const pathSegments = parsedUrl.pathname.split('/').filter(Boolean)
    if (pathSegments[0] === S3_BUCKET_NAME) {
      return pathSegments.slice(1).join('/')
    }
  } catch {
    return null
  }

  return null
}

export const uploadFromUrl = async (
  sourceUrl: string,
  s3Key: string,
  contentType = 'audio/mpeg'
): Promise<string | null> => {
  try {
    const response = await axios.get<Buffer>(sourceUrl, { responseType: 'arraybuffer' })
    const buffer = Buffer.from(response.data)
    return uploadToS3(s3Key, buffer, contentType)
  } catch (err) {
    logger.error('S3 uploadFromUrl error', { sourceUrl, s3Key, err })
    return null
  }
}
