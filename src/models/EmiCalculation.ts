import { Schema, model, Document, Types } from 'mongoose'

export interface IEmiCalculation extends Document {
  userId: Types.ObjectId
  userName: string
  loanAmount: number
  interestRate: number
  tenureYears: number
  tenureMonths: number
  monthlyEmi: number
  totalAmount: number
  totalInterest: number
  notes?: string | null
  createdAt: Date
  updatedAt: Date
}

const EmiCalculationSchema = new Schema<IEmiCalculation>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userName: { type: String, required: true },
    loanAmount: { type: Number, required: true },
    interestRate: { type: Number, required: true },
    tenureYears: { type: Number, required: true },
    tenureMonths: { type: Number, required: true },
    monthlyEmi: { type: Number, required: true },
    totalAmount: { type: Number, required: true },
    totalInterest: { type: Number, required: true },
    notes: { type: String, default: null },
  },
  { timestamps: true }
)

EmiCalculationSchema.index({ userId: 1, createdAt: -1 })

export const EmiCalculation = model<IEmiCalculation>('EmiCalculation', EmiCalculationSchema)
