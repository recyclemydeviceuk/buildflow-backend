import { Request, Response, NextFunction } from 'express'
import { EmiCalculation } from '../models/EmiCalculation'
import { sendEmail } from '../services/ses.service'
import { logger } from '../utils/logger'

// ─── helpers ──────────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n)

const fmtCurrency = (n: number) =>
  `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n)}`

// ─── GET /api/emi-calculator ──────────────────────────────────────────────────

export const getEmiCalculations = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page = '1', limit = '20' } = req.query as Record<string, string>

    const filter: Record<string, unknown> = {}

    // Managers can optionally see all; representatives see only their own
    if (req.user!.role === 'representative') {
      filter.userId = req.user!.id
    }

    const pageNum  = Math.max(1, parseInt(page))
    const limitNum = Math.min(100, parseInt(limit))
    const skip     = (pageNum - 1) * limitNum

    const [calculations, total] = await Promise.all([
      EmiCalculation.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
      EmiCalculation.countDocuments(filter),
    ])

    return res.status(200).json({
      success: true,
      data: calculations,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    })
  } catch (err) {
    next(err)
  }
}

// ─── POST /api/emi-calculator ─────────────────────────────────────────────────

export const saveEmiCalculation = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { loanAmount, interestRate, tenureYears, tenureMonths, monthlyEmi, totalAmount, totalInterest, notes } = req.body

    const calculation = await EmiCalculation.create({
      userId    : req.user!.id,
      userName  : req.user!.name,
      loanAmount,
      interestRate,
      tenureYears,
      tenureMonths,
      monthlyEmi,
      totalAmount,
      totalInterest,
      notes     : notes || null,
    })

    return res.status(201).json({ success: true, data: calculation })
  } catch (err) {
    next(err)
  }
}

// ─── DELETE /api/emi-calculator/:id ──────────────────────────────────────────

export const deleteEmiCalculation = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const calculation = await EmiCalculation.findById(req.params.id)
    if (!calculation) {
      return res.status(404).json({ success: false, message: 'Calculation not found' })
    }

    // Representatives can only delete their own calculations
    if (req.user!.role === 'representative' && String(calculation.userId) !== String(req.user!.id)) {
      return res.status(403).json({ success: false, message: 'Access denied' })
    }

    await EmiCalculation.findByIdAndDelete(req.params.id)
    return res.status(200).json({ success: true, message: 'Calculation deleted successfully' })
  } catch (err) {
    next(err)
  }
}

// ─── POST /api/emi-calculator/:id/send-email ─────────────────────────────────

export const sendEmiCalculationEmail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { recipientEmail } = req.body

    if (!recipientEmail) {
      return res.status(400).json({ success: false, message: 'Recipient email is required' })
    }

    const calculation = await EmiCalculation.findById(req.params.id)
    if (!calculation) {
      return res.status(404).json({ success: false, message: 'Calculation not found' })
    }

    // Representatives can only share their own calculations
    if (req.user!.role === 'representative' && String(calculation.userId) !== String(req.user!.id)) {
      return res.status(403).json({ success: false, message: 'Access denied' })
    }

    const html = buildEmiEmailHtml({
      recipientEmail,
      senderName     : req.user!.name,
      loanAmount     : calculation.loanAmount,
      interestRate   : calculation.interestRate,
      tenureYears    : calculation.tenureYears,
      tenureMonths   : calculation.tenureMonths,
      monthlyEmi     : calculation.monthlyEmi,
      totalAmount    : calculation.totalAmount,
      totalInterest  : calculation.totalInterest,
    })

    const sent = await sendEmail({
      to     : recipientEmail,
      subject: `EMI Calculation — ${fmtCurrency(calculation.loanAmount)} Loan`,
      html,
    })

    if (!sent) {
      return res.status(500).json({ success: false, message: 'Failed to send email. Please try again.' })
    }

    logger.info(`EMI calculation email sent to ${recipientEmail} by ${req.user!.email}`)
    return res.status(200).json({ success: true, message: `Email sent to ${recipientEmail}` })
  } catch (err) {
    next(err)
  }
}

// ─── HTML builder (inline so no extra template file needed) ──────────────────

function buildEmiEmailHtml(d: {
  recipientEmail : string
  senderName     : string
  loanAmount     : number
  interestRate   : number
  tenureYears    : number
  tenureMonths   : number
  monthlyEmi     : number
  totalAmount    : number
  totalInterest  : number
}) {
  const principalPct = Math.round((d.loanAmount / d.totalAmount) * 100)
  const interestPct  = 100 - principalPct

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>EMI Calculation</title>
</head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#1D4ED8,#3B82F6);padding:32px 40px;">
              <img src="https://res.cloudinary.com/desmurksp/image/upload/v1775226238/Buildflow_i2vkia.png" alt="BuildFlow" height="32" style="height:32px;width:auto;margin-bottom:20px;display:block;" />
              <h1 style="margin:0;color:#fff;font-size:24px;font-weight:700;letter-spacing:-0.5px;">EMI Calculation Summary</h1>
              <p style="margin:6px 0 0;color:rgba(255,255,255,0.75);font-size:14px;">Shared by ${d.senderName} · BuildFlow CRM</p>
            </td>
          </tr>

          <!-- Monthly EMI hero -->
          <tr>
            <td style="padding:32px 40px 0;text-align:center;">
              <p style="margin:0 0 4px;color:#64748B;font-size:13px;text-transform:uppercase;letter-spacing:0.8px;font-weight:600;">Monthly EMI</p>
              <p style="margin:0;color:#1D4ED8;font-size:48px;font-weight:800;letter-spacing:-1px;">₹${fmt(d.monthlyEmi)}</p>
            </td>
          </tr>

          <!-- Key stats grid -->
          <tr>
            <td style="padding:24px 40px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td width="33%" style="text-align:center;padding:16px 8px;background:#F8FAFC;border-radius:12px;margin:0 4px;">
                    <p style="margin:0 0 4px;color:#94A3B8;font-size:11px;text-transform:uppercase;letter-spacing:0.6px;font-weight:600;">Loan Amount</p>
                    <p style="margin:0;color:#0F172A;font-size:20px;font-weight:700;">₹${fmt(d.loanAmount)}</p>
                  </td>
                  <td width="4%"></td>
                  <td width="33%" style="text-align:center;padding:16px 8px;background:#F8FAFC;border-radius:12px;">
                    <p style="margin:0 0 4px;color:#94A3B8;font-size:11px;text-transform:uppercase;letter-spacing:0.6px;font-weight:600;">Total Interest</p>
                    <p style="margin:0;color:#DC2626;font-size:20px;font-weight:700;">₹${fmt(d.totalInterest)}</p>
                  </td>
                  <td width="4%"></td>
                  <td width="33%" style="text-align:center;padding:16px 8px;background:#F8FAFC;border-radius:12px;">
                    <p style="margin:0 0 4px;color:#94A3B8;font-size:11px;text-transform:uppercase;letter-spacing:0.6px;font-weight:600;">Total Payable</p>
                    <p style="margin:0;color:#0F172A;font-size:20px;font-weight:700;">₹${fmt(d.totalAmount)}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Loan details -->
          <tr>
            <td style="padding:0 40px 24px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E2E8F0;border-radius:12px;overflow:hidden;">
                <tr style="background:#F8FAFC;">
                  <th style="padding:12px 16px;text-align:left;color:#64748B;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #E2E8F0;">Parameter</th>
                  <th style="padding:12px 16px;text-align:right;color:#64748B;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #E2E8F0;">Value</th>
                </tr>
                <tr>
                  <td style="padding:12px 16px;color:#374151;font-size:14px;border-bottom:1px solid #F1F5F9;">Loan Amount</td>
                  <td style="padding:12px 16px;color:#0F172A;font-size:14px;font-weight:600;text-align:right;border-bottom:1px solid #F1F5F9;">₹${fmt(d.loanAmount)}</td>
                </tr>
                <tr style="background:#FAFBFC;">
                  <td style="padding:12px 16px;color:#374151;font-size:14px;border-bottom:1px solid #F1F5F9;">Annual Interest Rate</td>
                  <td style="padding:12px 16px;color:#0F172A;font-size:14px;font-weight:600;text-align:right;border-bottom:1px solid #F1F5F9;">${d.interestRate}%</td>
                </tr>
                <tr>
                  <td style="padding:12px 16px;color:#374151;font-size:14px;border-bottom:1px solid #F1F5F9;">Loan Tenure</td>
                  <td style="padding:12px 16px;color:#0F172A;font-size:14px;font-weight:600;text-align:right;border-bottom:1px solid #F1F5F9;">${d.tenureYears} Years (${d.tenureMonths} Months)</td>
                </tr>
                <tr style="background:#FAFBFC;">
                  <td style="padding:12px 16px;color:#374151;font-size:14px;border-bottom:1px solid #F1F5F9;">Monthly EMI</td>
                  <td style="padding:12px 16px;color:#1D4ED8;font-size:14px;font-weight:700;text-align:right;border-bottom:1px solid #F1F5F9;">₹${fmt(d.monthlyEmi)}</td>
                </tr>
                <tr>
                  <td style="padding:12px 16px;color:#374151;font-size:14px;border-bottom:1px solid #F1F5F9;">Total Interest Payable</td>
                  <td style="padding:12px 16px;color:#DC2626;font-size:14px;font-weight:600;text-align:right;border-bottom:1px solid #F1F5F9;">₹${fmt(d.totalInterest)}</td>
                </tr>
                <tr style="background:#EFF6FF;">
                  <td style="padding:14px 16px;color:#1D4ED8;font-size:14px;font-weight:700;">Total Amount Payable</td>
                  <td style="padding:14px 16px;color:#1D4ED8;font-size:14px;font-weight:700;text-align:right;">₹${fmt(d.totalAmount)}</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Breakdown bar -->
          <tr>
            <td style="padding:0 40px 32px;">
              <p style="margin:0 0 12px;color:#374151;font-size:13px;font-weight:600;">Loan Composition</p>
              <div style="height:10px;border-radius:999px;overflow:hidden;background:#E2E8F0;margin-bottom:8px;">
                <div style="height:100%;width:${principalPct}%;background:#1D4ED8;border-radius:999px 0 0 999px;display:inline-block;"></div>
              </div>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size:12px;color:#1D4ED8;font-weight:600;">● Principal ${principalPct}%</td>
                  <td style="font-size:12px;color:#DC2626;font-weight:600;text-align:right;">● Interest ${interestPct}%</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Disclaimer -->
          <tr>
            <td style="padding:20px 40px 32px;background:#F8FAFC;border-top:1px solid #E2E8F0;">
              <p style="margin:0;color:#94A3B8;font-size:11px;line-height:1.6;"><strong>Disclaimer:</strong> This calculation is for illustration purposes only and does not constitute a financial offer or advice. Actual EMI may vary based on lender policies, processing fees, and applicable taxes. Please consult a financial advisor for precise figures.</p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;text-align:center;border-top:1px solid #E2E8F0;">
              <p style="margin:0;color:#CBD5E1;font-size:11px;">Sent via BuildFlow CRM · © ${new Date().getFullYear()} BuildFlow</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}
