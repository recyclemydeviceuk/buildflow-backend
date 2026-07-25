import mongoose, { Schema, Document, Model } from 'mongoose'

// The media library stores any kind of uploaded file (images, video, audio,
// PDFs, spreadsheets, documents, archives, ...). `kind` is a coarse bucket we
// derive from the MIME type at upload time so the UI can pick an icon / preview
// renderer without re-parsing the MIME string everywhere.
export type MediaKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'spreadsheet'
  | 'document'
  | 'archive'
  | 'other'

export interface IMediaFile extends Document {
  uploadedBy: mongoose.Types.ObjectId
  uploadedByName: string
  fileName: string
  s3Key: string
  fileUrl: string
  mimeType: string
  kind: MediaKind
  fileSize: number
  description?: string | null
  // When set, this file belongs to a specific lead/client (attached from the
  // lead detail page) rather than the shared media library. `null` = a
  // library file visible to everyone. Lead-scoped files are excluded from the
  // library listing and only shown on that lead's page.
  lead?: mongoose.Types.ObjectId | null
  createdAt: Date
  updatedAt: Date
}

const MEDIA_KINDS: MediaKind[] = [
  'image',
  'video',
  'audio',
  'pdf',
  'spreadsheet',
  'document',
  'archive',
  'other',
]

const MediaFileSchema = new Schema<IMediaFile>(
  {
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // Denormalised so the library list renders without a populate round-trip
    // (and still shows a sensible name if the user is later deactivated).
    uploadedByName: { type: String, required: true },
    fileName: { type: String, required: true, trim: true },
    s3Key: { type: String, required: true },
    fileUrl: { type: String, required: true },
    mimeType: { type: String, required: true },
    kind: { type: String, enum: MEDIA_KINDS, default: 'other' },
    fileSize: { type: Number, required: true },
    description: { type: String, default: null, trim: true },
    lead: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
  },
  { timestamps: true }
)

MediaFileSchema.index({ uploadedBy: 1 })
MediaFileSchema.index({ kind: 1 })
MediaFileSchema.index({ createdAt: -1 })
// Fast lookup of a single lead's attachments, newest first.
MediaFileSchema.index({ lead: 1, createdAt: -1 })
// Case-insensitive name search support.
MediaFileSchema.index({ fileName: 'text' })

export const MediaFile: Model<IMediaFile> = mongoose.model<IMediaFile>('MediaFile', MediaFileSchema)
