import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IDeletedLeadPhone extends Document {
  phone: string        // normalized 10-digit phone
  deletedAt: Date
  deletedBy?: mongoose.Types.ObjectId | null
}

const DeletedLeadPhoneSchema = new Schema<IDeletedLeadPhone>(
  {
    phone: { type: String, required: true, unique: true },
    deletedAt: { type: Date, default: Date.now },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: false }
)

DeletedLeadPhoneSchema.index({ phone: 1 }, { unique: true })

export const DeletedLeadPhone: Model<IDeletedLeadPhone> = mongoose.model<IDeletedLeadPhone>(
  'DeletedLeadPhone',
  DeletedLeadPhoneSchema
)
