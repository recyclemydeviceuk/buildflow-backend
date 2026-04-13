import { Request, Response, NextFunction } from 'express'
import mongoose from 'mongoose'
import { User } from '../models/User'
import { Lead } from '../models/Lead'
import { Call } from '../models/Call'
import { Reminder } from '../models/Reminder'

// Helper to calculate date ranges
const getDateRanges = () => {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
  const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)
  
  return { today, weekAgo, monthAgo }
}

// Get summary metrics for all representatives
export const getRepresentativesPerformance = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { today, weekAgo, monthAgo } = getDateRanges()
    
    // Get all active representatives
    const representatives = await User.find({ 
      role: 'representative', 
      isActive: true 
    }).select('-password').lean()
    
    // Get performance metrics for each representative
    const performanceData = await Promise.all(
      representatives.map(async (rep) => {
        const repId = new mongoose.Types.ObjectId(String(rep._id))
        
        // Lead metrics
        const [
          totalLeads,
          newLeadsToday,
          newLeadsWeek,
          newLeadsMonth,
          contactedLeads,
          qualifiedLeads,
          visitDone,
          meetingDone,
          bookingDone,
          failedLeads
        ] = await Promise.all([
          Lead.countDocuments({ owner: repId }),
          Lead.countDocuments({ owner: repId, createdAt: { $gte: today } }),
          Lead.countDocuments({ owner: repId, createdAt: { $gte: weekAgo } }),
          Lead.countDocuments({ owner: repId, createdAt: { $gte: monthAgo } }),
          Lead.countDocuments({ owner: repId, disposition: { $in: ['Contacted/Open', 'Qualified', 'Visit Done', 'Meeting Done', 'Negotiation Done', 'Booking Done', 'Agreement Done'] } }),
          Lead.countDocuments({ owner: repId, disposition: 'Qualified' }),
          Lead.countDocuments({ owner: repId, disposition: 'Visit Done' }),
          Lead.countDocuments({ owner: repId, disposition: 'Meeting Done' }),
          Lead.countDocuments({ owner: repId, disposition: { $in: ['Booking Done', 'Agreement Done'] } }),
          Lead.countDocuments({ owner: repId, disposition: 'Failed' })
        ])
        
        // Call metrics
        const [
          totalCalls,
          callsToday,
          callsWeek,
          callsMonth,
          connectedCalls,
          missedCalls,
          avgCallDuration
        ] = await Promise.all([
          Call.countDocuments({ representative: repId }),
          Call.countDocuments({ representative: repId, createdAt: { $gte: today } }),
          Call.countDocuments({ representative: repId, createdAt: { $gte: weekAgo } }),
          Call.countDocuments({ representative: repId, createdAt: { $gte: monthAgo } }),
          Call.countDocuments({ representative: repId, outcome: 'Connected' }),
          Call.countDocuments({ representative: repId, outcome: { $in: ['Not Answered', 'Busy', 'Wrong Number'] } }),
          Call.aggregate([
            { $match: { representative: repId, duration: { $gt: 0 } } },
            { $group: { _id: null, avgDuration: { $avg: '$duration' } } }
          ])
        ])
        
        // Calculate conversion rate
        const conversionRate = totalLeads > 0 
          ? Math.round(((bookingDone + (qualifiedLeads * 0.5)) / totalLeads) * 100) 
          : 0
        
        // Calculate connection rate
        const connectionRate = totalCalls > 0
          ? Math.round((connectedCalls / totalCalls) * 100)
          : 0
        
        return {
          id: rep._id,
          name: rep.name,
          email: rep.email,
          phone: rep.phone,
          avatarUrl: rep.avatarUrl,
          callAvailabilityStatus: rep.callAvailabilityStatus,
          lastLoginAt: rep.lastLoginAt,
          
          // Lead metrics
          leads: {
            total: totalLeads,
            today: newLeadsToday,
            week: newLeadsWeek,
            month: newLeadsMonth,
            contacted: contactedLeads,
            qualified: qualifiedLeads,
            visitDone,
            meetingDone,
            bookingDone,
            failed: failedLeads,
            conversionRate
          },
          
          // Call metrics
          calls: {
            total: totalCalls,
            today: callsToday,
            week: callsWeek,
            month: callsMonth,
            connected: connectedCalls,
            missed: missedCalls,
            avgDuration: avgCallDuration[0]?.avgDuration ? Math.round(avgCallDuration[0].avgDuration) : 0,
            connectionRate
          },
          
          // Activity score (0-100)
          activityScore: Math.min(100, Math.round(
            (newLeadsMonth * 2) + 
            (callsMonth * 3) + 
            (qualifiedLeads * 10) + 
            (bookingDone * 20)
          ))
        }
      })
    )
    
    // Sort by activity score (highest first)
    performanceData.sort((a, b) => b.activityScore - a.activityScore)
    
    return res.status(200).json({
      success: true,
      data: performanceData,
      summary: {
        totalRepresentatives: representatives.length,
        totalLeadsAssigned: performanceData.reduce((sum, rep) => sum + rep.leads.total, 0),
        totalCallsMade: performanceData.reduce((sum, rep) => sum + rep.calls.total, 0),
        avgConversionRate: performanceData.length > 0 
          ? Math.round(performanceData.reduce((sum, rep) => sum + rep.leads.conversionRate, 0) / performanceData.length)
          : 0
      }
    })
  } catch (err) {
    next(err)
  }
}

// Get detailed performance for a specific representative
export const getRepresentativeDetailPerformance = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params
    const { today, weekAgo, monthAgo } = getDateRanges()
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid representative ID' })
    }
    
    const repId = new mongoose.Types.ObjectId(id)
    
    // Get representative details
    const representative = await User.findById(repId).select('-password').lean()
    if (!representative || representative.role !== 'representative') {
      return res.status(404).json({ success: false, message: 'Representative not found' })
    }
    
    // Lead disposition breakdown
    const dispositionBreakdown = await Lead.aggregate([
      { $match: { owner: repId } },
      { $group: { _id: '$disposition', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ])
    
    // Lead source breakdown
    const sourceBreakdown = await Lead.aggregate([
      { $match: { owner: repId } },
      { $group: { _id: '$source', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ])
    
    // Daily activity for last 30 days
    const dailyActivity = await Call.aggregate([
      { 
        $match: { 
          representative: repId, 
          createdAt: { $gte: monthAgo } 
        } 
      },
      {
        $group: {
          _id: { 
            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }
          },
          calls: { $sum: 1 },
          connected: { 
            $sum: { $cond: [{ $eq: ['$outcome', 'Connected'] }, 1, 0] } 
          },
          totalDuration: { $sum: '$duration' }
        }
      },
      { $sort: { '_id.date': 1 } }
    ])
    
    // Recent leads (last 10)
    const recentLeads = await Lead.find({ owner: repId })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('name phone city disposition source createdAt')
      .lean()
    
    // Recent calls (last 10)
    const recentCalls = await Call.find({ representative: repId })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('leadName phone status outcome duration startedAt endedAt')
      .lean()
    
    // Upcoming reminders
    const upcomingReminders = await Reminder.find({ 
      user: repId, 
      status: 'pending',
      dueAt: { $gte: new Date() }
    })
      .sort({ dueAt: 1 })
      .limit(10)
      .select('title dueAt status lead leadName')
      .lean()
    
    // Time-based metrics
    const timeMetrics = await Promise.all([
      // Today's metrics
      Call.countDocuments({ representative: repId, createdAt: { $gte: today } }),
      Lead.countDocuments({ owner: repId, createdAt: { $gte: today } }),
      
      // This week's metrics
      Call.countDocuments({ representative: repId, createdAt: { $gte: weekAgo } }),
      Lead.countDocuments({ owner: repId, createdAt: { $gte: weekAgo } }),
      
      // This month's metrics
      Call.countDocuments({ representative: repId, createdAt: { $gte: monthAgo } }),
      Lead.countDocuments({ owner: repId, createdAt: { $gte: monthAgo } }),
      
      // Overall totals
      Call.countDocuments({ representative: repId }),
      Lead.countDocuments({ owner: repId })
    ])
    
    const [
      callsToday,
      leadsToday,
      callsWeek,
      leadsWeek,
      callsMonth,
      leadsMonth,
      callsTotal,
      leadsTotal
    ] = timeMetrics
    
    // Call outcomes breakdown
    const callOutcomes = await Call.aggregate([
      { $match: { representative: repId } },
      { $group: { _id: '$outcome', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ])
    
    return res.status(200).json({
      success: true,
      data: {
        representative: {
          id: representative._id,
          name: representative.name,
          email: representative.email,
          phone: representative.phone,
          avatarUrl: representative.avatarUrl,
          callAvailabilityStatus: representative.callAvailabilityStatus,
          callDeviceMode: representative.callDeviceMode,
          lastLoginAt: representative.lastLoginAt,
          createdAt: representative.createdAt
        },
        
        timeMetrics: {
          today: { calls: callsToday, leads: leadsToday },
          week: { calls: callsWeek, leads: leadsWeek },
          month: { calls: callsMonth, leads: leadsMonth },
          total: { calls: callsTotal, leads: leadsTotal }
        },
        
        leadAnalytics: {
          dispositionBreakdown: dispositionBreakdown.map(d => ({ status: d._id, count: d.count })),
          sourceBreakdown: sourceBreakdown.map(s => ({ source: s._id, count: s.count })),
          recent: recentLeads
        },
        
        callAnalytics: {
          outcomes: callOutcomes.map(o => ({ outcome: o._id || 'Unknown', count: o.count })),
          recent: recentCalls,
          dailyActivity: dailyActivity.map(d => ({
            date: d._id.date,
            calls: d.calls,
            connected: d.connected,
            avgDuration: d.calls > 0 ? Math.round(d.totalDuration / d.calls) : 0
          }))
        },
        
        upcomingReminders: upcomingReminders.map(r => ({
          id: r._id,
          title: r.title,
          dueAt: r.dueAt,
          status: r.status,
          leadName: r.leadName,
          leadId: r.lead
        }))
      }
    })
  } catch (err) {
    next(err)
  }
}
