import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IDeletedLeadExternalId extends Document {
  externalId: string
  source?: string | null
  deletedAt: Date
  deletedBy?: mongoose.Types.ObjectId | null
}

const DeletedLeadExternalIdSchema = new Schema<IDeletedLeadExternalId>(
  {
    externalId: { type: String, required: true, unique: true },
    source: { type: String, default: null },
    deletedAt: { type: Date, default: Date.now },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: false }
)

DeletedLeadExternalIdSchema.index({ externalId: 1 }, { unique: true })

export const DeletedLeadExternalId: Model<IDeletedLeadExternalId> = mongoose.model<IDeletedLeadExternalId>(
  'DeletedLeadExternalId',
  DeletedLeadExternalIdSchema
)
