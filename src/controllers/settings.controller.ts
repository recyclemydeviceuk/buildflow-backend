import { Request, Response, NextFunction } from 'express'
import bcrypt from 'bcryptjs'
import { Settings } from '../models/Settings'
import { User } from '../models/User'
import { BCRYPT_SALT_ROUNDS } from '../config/constants'
import { emitUserAvailabilityUpdate } from '../config/socket'
import { sendWelcomeEmail } from '../services/ses.service'
import { normalizeNotificationPrefs } from '../utils/notificationPrefs'
import { normalizeLeadFields } from '../utils/leadFields'
import { normalizeFeatureControls } from '../utils/featureControls'

const broadcastUserAvailability = (user: any) => {
  emitUserAvailabilityUpdate({
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    phone: user.phone || null,
    callAvailabilityStatus: user.callAvailabilityStatus || 'available',
    callDeviceMode: user.callDeviceMode || 'phone',
    activeCallSid: user.activeCallSid || null,
    isActive: user.isActive,
  })
}

const serializeUser = (user: any) => ({
  ...user.toObject(),
  notificationPrefs: normalizeNotificationPrefs(user.notificationPrefs),
})

const serializeSettings = (settings: any) => {
  const rawSettings = settings?.toObject ? settings.toObject() : settings
  const featureControls = normalizeFeatureControls(rawSettings?.featureControls, rawSettings?.leadRouting?.mode)

  return {
    ...rawSettings,
    leadFields: normalizeLeadFields(rawSettings?.leadFields),
    leadRouting: {
      mode: featureControls.manualAssignment ? 'manual' : 'auto',
      offerTimeout: rawSettings?.leadRouting?.offerTimeout ?? 60,
      skipLimit: rawSettings?.leadRouting?.skipLimit ?? 0,
      autoEscalate: rawSettings?.leadRouting?.autoEscalate ?? false,
    },
    featureControls,
  }
}

const serializeAppConfig = (settings: any) => {
  const serialized = serializeSettings(settings)

  return {
    leadRouting: serialized.leadRouting,
    featureControls: serialized.featureControls,
  }
}

export const updateMyProfile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, email, phone, notificationPrefs, callAvailabilityStatus, callDeviceMode } = req.body

    const currentUser = await User.findById(req.user!.id).select('activeCallSid callAvailabilityStatus notificationPrefs email')
    if (!currentUser) {
      return res.status(404).json({ success: false, message: 'User not found' })
    }

    if (callAvailabilityStatus === 'offline' && (currentUser.activeCallSid || currentUser.callAvailabilityStatus === 'in-call')) {
      return res.status(409).json({
        success: false,
        message: 'You cannot go offline while a call is ringing or in progress',
      })
    }

    if (email && email.toLowerCase() !== currentUser.email.toLowerCase()) {
      const duplicate = await User.findOne({ email: email.toLowerCase(), _id: { $ne: req.user!.id } })
      if (duplicate) {
        return res.status(409).json({ success: false, message: 'This email is already in use by another account' })
      }
    }

    const nextNotificationPrefs =
      notificationPrefs && typeof notificationPrefs === 'object'
        ? {
            newLeadAlerts: notificationPrefs.newLeadAlerts ?? currentUser.notificationPrefs?.newLeadAlerts ?? true,
            reminderAlerts: notificationPrefs.reminderAlerts ?? currentUser.notificationPrefs?.reminderAlerts ?? true,
            missedCallAlerts: notificationPrefs.missedCallAlerts ?? currentUser.notificationPrefs?.missedCallAlerts ?? true,
            assignmentAlerts: notificationPrefs.assignmentAlerts ?? currentUser.notificationPrefs?.assignmentAlerts ?? true,
            dailyDigest: notificationPrefs.dailyDigest ?? currentUser.notificationPrefs?.dailyDigest ?? false,
            loginAlerts: notificationPrefs.loginAlerts ?? currentUser.notificationPrefs?.loginAlerts ?? false,
          }
        : undefined

    const updateFields: Record<string, unknown> = { name, phone, notificationPrefs: nextNotificationPrefs, callAvailabilityStatus, callDeviceMode }
    if (email) updateFields.email = email.toLowerCase()

    const user = await User.findByIdAndUpdate(
      req.user!.id,
      updateFields,
      { new: true, runValidators: true }
    ).select('-password')

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' })
    }

    broadcastUserAvailability(user)

    return res.status(200).json({ success: true, data: serializeUser(user) })
  } catch (err) {
    next(err)
  }
}

export const getSettings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    let settings = await Settings.findOne()
    if (!settings) {
      settings = await Settings.create({})
    }
    return res.status(200).json({
      success: true,
      data: serializeSettings(settings),
    })
  } catch (err) {
    next(err)
  }
}

export const getAppConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    let settings = await Settings.findOne()
    if (!settings) {
      settings = await Settings.create({})
    }

    return res.status(200).json({
      success: true,
      data: serializeAppConfig(settings),
    })
  } catch (err) {
    next(err)
  }
}

export const getSmsTemplates = async (req: Request, res: Response, next: NextFunction) => {
  try {
    let settings = await Settings.findOne()
    if (!settings) {
      settings = await Settings.create({})
    }

    return res.status(200).json({ success: true, data: settings.smsTemplates || [] })
  } catch (err) {
    next(err)
  }
}

export const updateSmsTemplates = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const templates = Array.isArray(req.body.templates) ? req.body.templates : []

    const normalizedTemplates = templates.map((template: any, index: number) => ({
      id: String(template.id || template.title || `template-${index + 1}`)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, ''),
      title: String(template.title || '').trim(),
      body: String(template.body || '').trim(),
      isActive: template.isActive !== false,
    }))

    const settings = await Settings.findOneAndUpdate(
      {},
      { smsTemplates: normalizedTemplates },
      { new: true, upsert: true, runValidators: true }
    )

    return res.status(200).json({ success: true, data: settings?.smsTemplates || [] })
  } catch (err) {
    next(err)
  }
}

export const updateLeadRouting = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { offerTimeout, skipLimit } = req.body

    const settings = await Settings.findOneAndUpdate(
      {},
      {
        'leadRouting.mode': 'manual',
        'leadRouting.offerTimeout': Number.isFinite(Number(offerTimeout)) ? Number(offerTimeout) : 60,
        'leadRouting.skipLimit': Number.isFinite(Number(skipLimit)) ? Number(skipLimit) : 0,
        'leadRouting.autoEscalate': false,
        'featureControls.manualAssignment': true,
      },
      { new: true, upsert: true }
    )

    return res.status(200).json({ success: true, data: serializeSettings(settings) })
  } catch (err) {
    next(err)
  }
}

export const updateLeadFields = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const nextLeadFields = normalizeLeadFields({
      fields: Array.isArray(req.body?.fields) ? req.body.fields : undefined,
      plotSizeUnits: req.body?.plotSizeUnits,
      defaultUnit: req.body?.defaultUnit,
      buildTypes: req.body?.buildTypes,
    })

    const settings = await Settings.findOneAndUpdate(
      {},
      {
        leadFields: nextLeadFields,
      },
      { new: true, upsert: true }
    )

    return res.status(200).json({
      success: true,
      data: {
        ...settings?.toObject(),
        leadFields: normalizeLeadFields(settings?.leadFields),
      },
    })
  } catch (err) {
    next(err)
  }
}

export const updateCities = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cities } = req.body

    const settings = await Settings.findOneAndUpdate(
      {},
      { cities },
      { new: true, upsert: true }
    )

    return res.status(200).json({ success: true, data: settings })
  } catch (err) {
    next(err)
  }
}

export const updateSources = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sources } = req.body

    if (!Array.isArray(sources) || sources.some((s) => typeof s !== 'string')) {
      return res.status(400).json({ success: false, message: 'sources must be an array of strings' })
    }

    const settings = await Settings.findOneAndUpdate(
      {},
      { sources: sources.map((s: string) => s.trim()).filter(Boolean) },
      { new: true, upsert: true }
    )

    return res.status(200).json({ success: true, data: settings })
  } catch (err) {
    next(err)
  }
}

export const updateFeatureControls = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const currentSettings = await Settings.findOne()
    const existingFeatureControls =
      currentSettings?.featureControls && typeof (currentSettings.featureControls as any).toObject === 'function'
        ? (currentSettings.featureControls as any).toObject()
        : currentSettings?.featureControls || {}
    const normalizedFeatureControls = normalizeFeatureControls(req.body, currentSettings?.leadRouting?.mode)

    const settings = await Settings.findOneAndUpdate(
      {},
      {
        featureControls: {
          ...existingFeatureControls,
          ...normalizedFeatureControls,
        },
        'leadRouting.mode': normalizedFeatureControls.manualAssignment ? 'manual' : 'auto',
      },
      { new: true, upsert: true, runValidators: true }
    )

    return res.status(200).json({ success: true, data: serializeSettings(settings) })
  } catch (err) {
    next(err)
  }
}

export const updateNotificationSettings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await Settings.findOneAndUpdate(
      {},
      { notifications: req.body },
      { new: true, upsert: true }
    )

    return res.status(200).json({ success: true, data: settings })
  } catch (err) {
    next(err)
  }
}

export const getTeamMembers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const members = await User.find().select('-password')
    return res.status(200).json({ success: true, data: members })
  } catch (err) {
    next(err)
  }
}

export const createTeamMember = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, email, role, phone, password, managerKey } = req.body

    if (role === 'manager') {
      const expectedKey = process.env.MANAGER_CREATION_KEY
      if (!expectedKey) {
        return res.status(500).json({ success: false, message: 'Manager creation key is not configured on this server' })
      }
      if (!managerKey || managerKey !== expectedKey) {
        return res.status(403).json({ success: false, message: 'Invalid manager creation key' })
      }
    }

    const existing = await User.findOne({ email: email.toLowerCase() })
    if (existing) {
      return res.status(409).json({ success: false, message: 'User with this email already exists' })
    }

    const user = await User.create({
      name,
      email: email.toLowerCase(),
      role,
      phone,
      password: await bcrypt.hash(password, BCRYPT_SALT_ROUNDS),
      isActive: true,
      notificationPrefs: normalizeNotificationPrefs(),
    })

    void sendWelcomeEmail(user.email, user.name, password).catch(() => null)

    broadcastUserAvailability(user)

    return res.status(201).json({
      success: true,
      data: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone,
        isActive: user.isActive,
        callAvailabilityStatus: user.callAvailabilityStatus,
        callDeviceMode: user.callDeviceMode,
        notificationPrefs: normalizeNotificationPrefs(user.notificationPrefs),
      },
    })
  } catch (err) {
    next(err)
  }
}

export const updateTeamMember = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, email, role, phone, isActive, callAvailabilityStatus, callDeviceMode } = req.body

    const currentUser = await User.findById(req.params.id).select('activeCallSid callAvailabilityStatus')
    if (!currentUser) {
      return res.status(404).json({ success: false, message: 'Team member not found' })
    }

    if (callAvailabilityStatus === 'offline' && (currentUser.activeCallSid || currentUser.callAvailabilityStatus === 'in-call')) {
      return res.status(409).json({
        success: false,
        message: 'You cannot mark this teammate offline while a call is ringing or in progress',
      })
    }

    if (email) {
      const conflict = await User.findOne({ email: email.toLowerCase(), _id: { $ne: req.params.id } })
      if (conflict) {
        return res.status(409).json({ success: false, message: 'Another user with that email already exists' })
      }
    }

    const updateFields: Record<string, any> = { name, role, phone, isActive, callAvailabilityStatus, callDeviceMode }
    if (email) updateFields.email = email.toLowerCase()

    const user = await User.findByIdAndUpdate(
      req.params.id,
      updateFields,
      { new: true, runValidators: true }
    ).select('-password')

    if (!user) {
      return res.status(404).json({ success: false, message: 'Team member not found' })
    }

    broadcastUserAvailability(user)

    return res.status(200).json({ success: true, data: user })
  } catch (err) {
    next(err)
  }
}

export const resetMemberPassword = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.params.id)
    if (!user) {
      return res.status(404).json({ success: false, message: 'Team member not found' })
    }

    const newPassword = req.body.newPassword || Math.random().toString(36).slice(-12)
    user.password = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS)
    await user.save()

    return res.status(200).json({ success: true, data: { temporaryPassword: newPassword } })
  } catch (err) {
    next(err)
  }
}

export const deactivateTeamMember = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    ).select('-password')

    if (!user) {
      return res.status(404).json({ success: false, message: 'Team member not found' })
    }

    broadcastUserAvailability(user)

    return res.status(200).json({ success: true, data: user })
  } catch (err) {
    next(err)
  }
}

export const activateTeamMember = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isActive: true },
      { new: true }
    ).select('-password')

    if (!user) {
      return res.status(404).json({ success: false, message: 'Team member not found' })
    }

    broadcastUserAvailability(user)

    return res.status(200).json({ success: true, data: user })
  } catch (err) {
    next(err)
  }
}

export const deleteTeamMember = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.params.id)
    if (!user) {
      return res.status(404).json({ success: false, message: 'Team member not found' })
    }

    if (String(user._id) === String((req as any).user?.id)) {
      return res.status(400).json({ success: false, message: 'You cannot permanently delete your own account' })
    }

    await User.findByIdAndDelete(req.params.id)

    return res.status(200).json({ success: true, message: 'Team member permanently deleted' })
  } catch (err) {
    next(err)
  }
}
