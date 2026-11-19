const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 北京时间日期
function beijingDate(d) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/**
 * getPoints：积分概要（余额 + 累计 + 今日已得 + 称号 + 最近 20 条流水）。
 * 流水只增不改（对应文档 6.2）；积分有效期 12 个月，余额只计未过期流水。
 */
exports.main = async () => {
  try {
    const wxContext = cloud.getWXContext()
    const openid = wxContext.OPENID
    const today = beijingDate(new Date())
    const expiresBefore = new Date(Date.now() - 365 * 24 * 3600 * 1000)

    // 12 个月有效期：只统计创建时间在一年内的流水
    const ledgerRes = await db
      .collection('points_ledger')
      .where({ _openid: openid, createTime: db.command.gte(expiresBefore) })
      .orderBy('createTime', 'desc')
      .limit(100)
      .get()

    const ledger = ledgerRes.data || []
    let balance = 0
    let totalEarned = 0
    let earnedToday = 0
    for (const e of ledger) {
      const amount = e.amount || 0
      balance += amount
      if (amount > 0) totalEarned += amount
      const day = new Date(e.createTime).toISOString()
      if (day.slice(0, 10) === today && amount > 0) earnedToday += amount
    }

    // 已兑换称号（p_title 且订单完成）
    const titleRes = await db
      .collection('redeem_orders')
      .where({ _openid: openid, prizeId: 'p_title', status: 'done' })
      .limit(10)
      .get()
    const titles = (titleRes.data || []).map((o) => o.prizeName)

    return {
      code: 0,
      message: 'success',
      data: {
        balance,
        totalEarned,
        earnedToday,
        titles,
        ledger: ledger.slice(0, 20).map((e) => ({
          id: e._id,
          type: e.type,
          amount: e.amount,
          reason: e.reason,
          refId: e.refId,
          orderNo: e.orderNo,
          createdAt: new Date(e.createTime).toISOString()
        }))
      }
    }
  } catch (err) {
    console.error('[getPoints] error:', err)
    return { code: -1, message: err.message || '服务异常', data: null }
  }
}
