import { Request, Response, NextFunction } from 'express'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import mongoose from 'mongoose'
import { S3_MEDIA_PREFIX } from '../config/constants'
import { MediaFile, MediaKind } from '../models/MediaFile'
import {
  deleteFromS3,
  getPresignedDownloadUrl,
  getPresignedUrl,
  uploadToS3,
} from '../services/s3.service'

// How long presigned preview/download links stay valid. Kept short-ish so a
// leaked URL doesn't grant indefinite access; the frontend re-fetches on load.
const PREVIEW_URL_TTL_SECONDS = 60 * 60 // 1 hour

// Map a MIME type to the coarse `kind` bucket the UI uses to choose an icon
// and preview renderer. Exported so the lead-file controller reuses the exact
// same classification.
export const resolveMediaKind = (mimeType: string): MediaKind => {
  const type = (mimeType || '').toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  if (type === 'application/pdf') return 'pdf'
  if (
    type === 'text/csv' ||
    type === 'application/vnd.ms-excel' ||
    type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    return 'spreadsheet'
  }
  if (
    type === 'application/msword' ||
    type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    type === 'application/rtf' ||
    type.startsWith('text/')
  ) {
    return 'document'
  }
  if (
    type === 'application/zip' ||
    type === 'application/x-zip-compressed' ||
    type === 'application/x-rar-compressed' ||
    type === 'application/x-7z-compressed' ||
    type === 'application/gzip' ||
    type === 'application/x-tar'
  ) {
    return 'archive'
  }
  return 'other'
}

// Shape a MediaFile document for the API, attaching a short-lived presigned
// preview URL so the client can render/stream the file directly from storage.
// Exported so the lead-file controller returns identically-shaped payloads
// (the frontend reuses the same MediaFile type / preview modal).
export const serializeMediaFile = async (doc: any) => {
  const previewUrl = await getPresignedUrl(doc.s3Key, PREVIEW_URL_TTL_SECONDS)
  return {
    id: String(doc._id),
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    kind: doc.kind,
    fileSize: doc.fileSize,
    description: doc.description ?? null,
    uploadedBy: String(doc.uploadedBy),
    uploadedByName: doc.uploadedByName,
    lead: doc.lead ? String(doc.lead) : null,
    previewUrl,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

export const uploadMediaFile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' })
    }

    const ext = path.extname(req.file.originalname).toLowerCase()
    const key = `${S3_MEDIA_PREFIX}${req.user!.id}/${uuidv4()}${ext}`

    const fileUrl = await uploadToS3(key, req.file.buffer, req.file.mimetype)
    if (!fileUrl) {
      return res.status(500).json({ success: false, message: 'Could not upload file to storage' })
    }

    const description =
      typeof req.body?.description === 'string' && req.body.description.trim().length > 0
        ? req.body.description.trim().slice(0, 500)
        : null

    const doc = await MediaFile.create({
      uploadedBy: req.user!.id,
      uploadedByName: req.user!.name,
      fileName: req.file.originalname,
      s3Key: key,
      fileUrl,
      mimeType: req.file.mimetype,
      kind: resolveMediaKind(req.file.mimetype),
      fileSize: req.file.size,
      description,
    })

    return res.status(201).json({ success: true, data: await serializeMediaFile(doc) })
  } catch (err) {
    next(err)
  }
}

export const getMediaFiles = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(parseInt(String(req.query.page || '1'), 10) || 1, 1)
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '30'), 10) || 30, 1), 100)
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : ''
    const kind = typeof req.query.kind === 'string' ? req.query.kind.trim() : ''

    // The library is a shared workspace — every authenticated user sees every
    // file. (Deletion is still restricted to the uploader or a manager.)
    // Files attached to a specific lead live on that lead's page, not here, so
    // they're excluded from the shared library.
    const query: any = { lead: null }

    if (search) {
      // Escape regex metacharacters so a search like "report (1)" is literal.
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      query.fileName = { $regex: escaped, $options: 'i' }
    }

    const validKinds = ['image', 'video', 'audio', 'pdf', 'spreadsheet', 'document', 'archive', 'other']
    if (kind && validKinds.includes(kind)) {
      query.kind = kind
    }

    const [docs, total] = await Promise.all([
      MediaFile.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      MediaFile.countDocuments(query),
    ])

    const data = await Promise.all(docs.map((doc) => serializeMediaFile(doc)))

    return res.status(200).json({
      success: true,
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (err) {
    next(err)
  }
}

export const getMediaFileById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid file id' })
    }
    const doc = await MediaFile.findById(req.params.id).lean()
    if (!doc) {
      return res.status(404).json({ success: false, message: 'File not found' })
    }
    return res.status(200).json({ success: true, data: await serializeMediaFile(doc) })
  } catch (err) {
    next(err)
  }
}

// Returns a short-lived presigned URL that forces the browser to download the
// file under its original name. The frontend just points window.location /
// an anchor at this URL.
export const getMediaDownloadUrl = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid file id' })
    }
    const doc = await MediaFile.findById(req.params.id).lean()
    if (!doc) {
      return res.status(404).json({ success: false, message: 'File not found' })
    }

    const url = await getPresignedDownloadUrl(doc.s3Key, doc.fileName, PREVIEW_URL_TTL_SECONDS)
    if (!url) {
      return res.status(500).json({ success: false, message: 'Could not generate download link' })
    }

    return res.status(200).json({ success: true, data: { url } })
  } catch (err) {
    next(err)
  }
}

export const deleteMediaFile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid file id' })
    }
    const doc = await MediaFile.findById(req.params.id)
    if (!doc) {
      return res.status(404).json({ success: false, message: 'File not found' })
    }

    // Only the uploader or a manager can delete a file.
    const isOwner = String(doc.uploadedBy) === String(req.user!.id)
    if (!isOwner && req.user!.role !== 'manager') {
      return res.status(403).json({ success: false, message: 'You can only delete files you uploaded' })
    }

    await deleteFromS3(doc.s3Key)
    await doc.deleteOne()

    return res.status(200).json({ success: true, message: 'File deleted' })
  } catch (err) {
    next(err)
  }
}
