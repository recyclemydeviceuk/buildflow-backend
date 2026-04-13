import { S3Client } from '@aws-sdk/client-s3'
import { SESClient } from '@aws-sdk/client-ses'

const awsRegion = process.env.AWS_REGION || 'ap-south-1'
const storageRegion = process.env.AWS_S3_REGION || awsRegion
const storageBucketName = process.env.AWS_S3_BUCKET_NAME || ''
const storageProvider: 's3' | 'r2' = process.env.STORAGE_PROVIDER === 'r2' ? 'r2' : 's3'
const storageEndpoint = process.env.R2_ENDPOINT || undefined

const storageCredentials = {
  accessKeyId:
    process.env.R2_ACCESS_KEY_ID ||
    process.env.AWS_S3_ACCESS_KEY_ID ||
    process.env.AWS_ACCESS_KEY_ID ||
    '',
  secretAccessKey:
    process.env.R2_SECRET_ACCESS_KEY ||
    process.env.AWS_S3_SECRET_ACCESS_KEY ||
    process.env.AWS_SECRET_ACCESS_KEY ||
    '',
}

const awsCredentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
}

export const s3Client = new S3Client({
  region: storageRegion,
  credentials: storageCredentials,
  ...(storageEndpoint ? { endpoint: storageEndpoint } : {}),
  ...(storageProvider === 'r2' ? { forcePathStyle: true } : {}),
})

export const sesClient = new SESClient({
  region: process.env.AWS_SES_REGION || awsRegion,
  credentials: awsCredentials,
})

export const S3_BUCKET_NAME = storageBucketName
export const S3_PUBLIC_BASE_URL =
  process.env.AWS_S3_PUBLIC_BASE_URL ||
  process.env.R2_PUBLIC_BASE_URL ||
  ''
export const S3_REGION = storageRegion
export const S3_PROVIDER = storageProvider
export const S3_ENDPOINT = storageEndpoint
export const SES_FROM_EMAIL = process.env.AWS_SES_FROM_EMAIL || 'noreply@buildflow.in'
export const SES_FROM_NAME = process.env.AWS_SES_FROM_NAME || 'BuildFlow'
