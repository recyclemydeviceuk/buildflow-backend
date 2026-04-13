import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IImportJob extends Document {
  jobId: string
  uploadedBy: mongoose.Types.ObjectId
  fileName: string
  fileUrl: string
  s3Key: string
  status: 'uploaded' | 'processing' | 'completed' | 'failed'
  fileSize: number
  totalRows?: number
  importedRows?: number
  skippedRows?: number
  importErrors?: string[]
  completedAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

const ImportJobSchema = new Schema<IImportJob>(
  {
    jobId: { type: String, required: true, unique: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    fileName: { type: String, required: true },
    fileUrl: { type: String, required: true },
    s3Key: { type: String, required: true },
    status: {
      type: String,
      enum: ['uploaded', 'processing', 'completed', 'failed'],
      default: 'uploaded',
    },
    fileSize: { type: Number, required: true },
    totalRows: { type: Number },
    importedRows: { type: Number },
    skippedRows: { type: Number },
    importErrors: [{ type: String }],
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
)

ImportJobSchema.index({ uploadedBy: 1 })
ImportJobSchema.index({ status: 1 })
ImportJobSchema.index({ createdAt: -1 })

export const ImportJob: Model<IImportJob> = mongoose.model<IImportJob>('ImportJob', ImportJobSchema)
