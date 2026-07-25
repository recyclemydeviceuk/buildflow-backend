import { Request, Response, NextFunction } from 'express'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import mongoose from 'mongoose'
import { S3_LEAD_FILES_PREFIX } from '../config/constants'
import { Lead } from '../models/Lead'
import { MediaFile } from '../models/MediaFile'
import { resolveMediaKind, serializeMediaFile } from './media.controller'
import {
  deleteFromS3,
  getPresignedDownloadUrl,
  uploadToS3,
} from '../services/s3.service'

// How long presigned download links stay valid. Matches the media library.
const DOWNLOAD_URL_TTL_SECONDS = 60 * 60 // 1 hour

const MAX_DESCRIPTION_LENGTH = 500

// A rep may view / attach files on a lead they own OR on a lead that is not yet
// assigned to anyone (mirrors the follow-up access rules). Managers always
// have access. Returns null when access is granted, or an error tuple to send.
const checkLeadAccess = (
  req: Request,
  lead: { owner?: unknown } | null
): { status: number; message: string } | null => {
  if (!lead) return { status: 404, message: 'Lead not found' }
  if (req.user!.role === 'manager') return null
  const isOwner = Boolean(lead.owner) && String(lead.owner) === String(req.user!.id)
  const isUnassigned = !lead.owner || String(lead.owner) === ''
  if (!isOwner && !isUnassigned) {
    return { status: 403, message: 'Access denied' }
  }
  return null
}

// GET /leads/:id/files — every attachment on a single lead, newest first.
export const getLeadFiles = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params

    const lead = await Lead.findById(id).select('owner').lean()
    const accessError = checkLeadAccess(req, lead)
    if (accessError) {
      return res.status(accessError.status).json({ success: false, message: accessError.message })
    }

    const docs = await MediaFile.find({ lead: new mongoose.Types.ObjectId(id) })
      .sort({ createdAt: -1 })
      .lean()

    const data = await Promise.all(docs.map((doc) => serializeMediaFile(doc)))

    return res.status(200).json({ success: true, data })
  } catch (err) {
    next(err)
  }
}

// POST /leads/:id/files — attach a new file to a lead. Accepts any file type
// (same as the media library); only the size is bounded by the multer config.
export const uploadLeadFile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params

    const lead = await Lead.findById(id).select('owner').lean()
    const accessError = checkLeadAccess(req, lead)
    if (accessError) {
      return res.status(accessError.status).json({ success: false, message: accessError.message })
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' })
    }

    const ext = path.extname(req.file.originalname).toLowerCase()
    // Group every lead's files under lead-files/<leadId>/ in the bucket.
    const key = `${S3_LEAD_FILES_PREFIX}${id}/${uuidv4()}${ext}`

    const fileUrl = await uploadToS3(key, req.file.buffer, req.file.mimetype)
    if (!fileUrl) {
      return res.status(500).json({ success: false, message: 'Could not upload file to storage' })
    }

    const description =
      typeof req.body?.description === 'string' && req.body.description.trim().length > 0
        ? req.body.description.trim().slice(0, MAX_DESCRIPTION_LENGTH)
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
      lead: new mongoose.Types.ObjectId(id),
    })

    return res.status(201).json({ success: true, data: await serializeMediaFile(doc) })
  } catch (err) {
    next(err)
  }
}

// Load a lead-scoped file and confirm it belongs to the lead in the URL. Keeps
// the download/delete handlers from acting on a file that isn't on this lead.
const findLeadFile = async (leadId: string, fileId: string) => {
  const doc = await MediaFile.findById(fileId)
  if (!doc || !doc.lead || String(doc.lead) !== String(leadId)) return null
  return doc
}

// GET /leads/:id/files/:fileId/download — short-lived presigned URL that forces
// a download under the original file name.
export const getLeadFileDownloadUrl = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, fileId } = req.params

    const lead = await Lead.findById(id).select('owner').lean()
    const accessError = checkLeadAccess(req, lead)
    if (accessError) {
      return res.status(accessError.status).json({ success: false, message: accessError.message })
    }

    const doc = await findLeadFile(id, fileId)
    if (!doc) {
      return res.status(404).json({ success: false, message: 'File not found' })
    }

    const url = await getPresignedDownloadUrl(doc.s3Key, doc.fileName, DOWNLOAD_URL_TTL_SECONDS)
    if (!url) {
      return res.status(500).json({ success: false, message: 'Could not generate download link' })
    }

    return res.status(200).json({ success: true, data: { url } })
  } catch (err) {
    next(err)
  }
}

// DELETE /leads/:id/files/:fileId — remove an attachment. The uploader, the
// lead's current owner, or a manager can delete.
export const deleteLeadFile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, fileId } = req.params

    const lead = await Lead.findById(id).select('owner').lean()
    const accessError = checkLeadAccess(req, lead)
    if (accessError) {
      return res.status(accessError.status).json({ success: false, message: accessError.message })
    }

    const doc = await findLeadFile(id, fileId)
    if (!doc) {
      return res.status(404).json({ success: false, message: 'File not found' })
    }

    const isManager = req.user!.role === 'manager'
    const isUploader = String(doc.uploadedBy) === String(req.user!.id)
    const isLeadOwner = Boolean(lead!.owner) && String(lead!.owner) === String(req.user!.id)
    if (!isManager && !isUploader && !isLeadOwner) {
      return res
        .status(403)
        .json({ success: false, message: 'You can only delete files you uploaded' })
    }

    await deleteFromS3(doc.s3Key)
    await doc.deleteOne()

    return res.status(200).json({ success: true, message: 'File deleted' })
  } catch (err) {
    next(err)
  }
}
