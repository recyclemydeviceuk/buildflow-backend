import { Request, Response, NextFunction } from 'express'
import { S3_AVATARS_PREFIX, S3_IMPORTS_PREFIX } from '../config/constants'
import { User } from '../models/User'
import { ImportJob } from '../models/ImportJob'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import { deleteFromS3, getS3KeyFromUrl, uploadToS3 } from '../services/s3.service'

export const uploadAvatar = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' })
    }

    const ext = path.extname(req.file.originalname).toLowerCase()
    const key = `${S3_AVATARS_PREFIX}${req.user!.id}/${uuidv4()}${ext}`
    const existingUser = await User.findById(req.user!.id).select('avatarUrl')
    const avatarUrl = await uploadToS3(key, req.file.buffer, req.file.mimetype, true)
    if (!avatarUrl) {
      return res.status(500).json({ success: false, message: 'Could not upload avatar' })
    }

    const user = await User.findByIdAndUpdate(
      req.user!.id,
      { avatarUrl },
      { new: true }
    ).select('-password')

    if (existingUser?.avatarUrl) {
      const previousKey = getS3KeyFromUrl(existingUser.avatarUrl)
      if (previousKey && previousKey !== key) {
        await deleteFromS3(previousKey)
      }
    }

    return res.status(200).json({ success: true, data: { avatarUrl, user } })
  } catch (err) {
    next(err)
  }
}

export const deleteAvatar = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.user!.id)
    if (!user || !user.avatarUrl) {
      return res.status(404).json({ success: false, message: 'No avatar to delete' })
    }

    const key = getS3KeyFromUrl(user.avatarUrl)
    if (key) {
      await deleteFromS3(key)
    }

    await User.findByIdAndUpdate(req.user!.id, { avatarUrl: null })

    return res.status(200).json({ success: true, message: 'Avatar deleted' })
  } catch (err) {
    next(err)
  }
}

export const uploadImportFile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' })
    }

    const ext = path.extname(req.file.originalname).toLowerCase()
    const jobId = uuidv4()
    const key = `${S3_IMPORTS_PREFIX}${req.user!.id}/${jobId}${ext}`
    const fileUrl = await uploadToS3(key, req.file.buffer, req.file.mimetype)
    if (!fileUrl) {
      return res.status(500).json({ success: false, message: 'Could not upload import file' })
    }

    const job = await ImportJob.create({
      jobId,
      uploadedBy: req.user!.id,
      fileName: req.file.originalname,
      fileUrl,
      s3Key: key,
      status: 'uploaded',
      fileSize: req.file.size,
    })

    return res.status(201).json({ success: true, data: job })
  } catch (err) {
    next(err)
  }
}

export const getImportJobs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const jobs = await ImportJob.find({ uploadedBy: req.user!.id })
      .sort({ createdAt: -1 })
      .limit(20)

    return res.status(200).json({ success: true, data: jobs })
  } catch (err) {
    next(err)
  }
}

export const getImportJobById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await ImportJob.findById(req.params.id)
    if (!job) {
      return res.status(404).json({ success: false, message: 'Import job not found' })
    }
    return res.status(200).json({ success: true, data: job })
  } catch (err) {
    next(err)
  }
}
