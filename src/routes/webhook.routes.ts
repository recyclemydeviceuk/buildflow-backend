import { Router } from 'express'
import multer from 'multer'
import {
  handleExotelCallStatus,
  handleExotelSmsStatus,
  handleExotelAnalyzeResult,
  handleWebsiteLead,
  handleMetaLeadWebhook,
  verifyMetaWebhook,
  handleWhatsAppWebhook,
  verifyWhatsAppWebhook,
} from '../controllers/webhook.controller'

const router = Router()
const exotelMultipart = multer().none()

const parseExotelWebhook = (req: any, res: any, next: any) => {
  if (req.is('multipart/form-data')) {
    return exotelMultipart(req, res, next)
  }
  return next()
}

router.post('/exotel/call-status', parseExotelWebhook, handleExotelCallStatus)
router.post('/exotel/sms-status', parseExotelWebhook, handleExotelSmsStatus)
router.post('/exotel/analyze', handleExotelAnalyzeResult)

router.post('/website/lead', handleWebsiteLead)

router.get('/meta', verifyMetaWebhook)
router.post('/meta', handleMetaLeadWebhook)

router.get('/whatsapp', verifyWhatsAppWebhook)
router.post('/whatsapp', handleWhatsAppWebhook)

export default router
