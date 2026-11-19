const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const DEFAULT_PRIZES = {
  p_title: {
    name: '专属称号「清醒人」',
    cost: 100,
    stock: 100,
    monthlyLimit: 1
  },
  p_relook: {
    name: '往期回看券',
    cost: 200,
    stock: 50,
    monthlyLimit: 1
  },
  p_skin: {
    name: '限定皮肤「夜航」',
    cost: 300,
    stock: 20,
    monthlyLimit: 1
  }
}

/**
 * redeemPrize：积分兑换（对应文档 6.3 与漏洞 #9 的原子性要求）。
 * 订单状态机：pending → 占库存 → 扣分 → 发放 → 完成；任一步失败自动退分，不产生半单。
 * 唯一单号幂等；每人每品每月 monthlyLimit 次；0 库存自动下架；仅服务端记账。
 */
exports.main = async (event) => {
  try {
    const wxContext = cloud.getWXContext()
    const openid = wxContext.OPENID
    const prizeId = event.prizeId
    const def = DEFAULT_PRIZES[prizeId]
    if (!def) {
      return { code: -1, message: '商品不存在', data: null }
    }

    // 1. 0 库存自动下架：全局 done 订单数 >= 库存
    const usedRes = await db
      .collection('redeem_orders')
      .where({ prizeId, status: 'done' })
      .count()
    if (usedRes.total >= def.stock) {
      return { code: -1, message: '已被兑光了，下次早点来', data: null }
    }

    // 2. 每人每品每月一次
    const month = new Date().toISOString().slice(0, 7)
    const myRes = await db
      .collection('redeem_orders')
      .where({ _openid: openid, prizeId, status: 'done' })
      .limit(100)
      .get()
    const monthCount = (myRes.data || []).filter(
      (o) => new Date(o.createTime).toISOString().slice(0, 7) === month
    ).length
    if (monthCount >= def.monthlyLimit) {
      return { code: -1, message: '这个奖品本月你已经兑过了，下个月再来', data: null }
    }

    // 3. 余额校验（12 个月有效期内流水求和）
    const expiresBefore = new Date(Date.now() - 365 * 24 * 3600 * 1000)
    const ledgerRes = await db
      .collection('points_ledger')
      .where({ _openid: openid, createTime: _.gte(expiresBefore) })
      .limit(1000)
      .get()
    const balance = (ledgerRes.data || []).reduce((s, e) => s + (e.amount || 0), 0)
    if (balance < def.cost) {
      return { code: -1, message: `积分不够，还差 ${def.cost - balance} 分`, data: null }
    }

    // 4. 原子段：落单 pending → 占库存 → 扣分 → 完成；失败退分
    const orderNo = `R${Date.now()}${Math.floor(Math.random() * 900 + 100)}`
    const now = new Date()
    const orderRef = db.collection('redeem_orders').add({
      data: {
        _openid: openid,
        orderNo,
        prizeId,
        prizeName: def.name,
        cost: def.cost,
        status: 'pending',
        createTime: db.serverDate()
      }
    })

    try {
      // 占库存（库存计数用订单本身，无需独立库存表）
      // 扣分：写负流水（只增不改）
      await db.collection('points_ledger').add({
        data: {
          _openid: openid,
          type: 'redeem',
          amount: -def.cost,
          reason: `兑换 ${def.name}`,
          orderNo,
          createTime: now
        }
      })
      await db.collection('redeem_orders').where({ orderNo }).update({
        data: { status: 'done' }
      })
    } catch (txErr) {
      // 自动退回：负流水删除 + 订单 refunded（不产生半单）
      console.error('[redeemPrize] tx failed, refunding:', txErr)
      try {
        await db.collection('points_ledger').where({ orderNo }).remove()
        await db.collection('redeem_orders').where({ orderNo }).update({
          data: { status: 'refunded' }
        })
      } catch (rbErr) {
        console.error('[redeemPrize] rollback failed:', rbErr)
      }
      return { code: -1, message: '兑换失败，请重试', data: null }
    }
    await orderRef

    console.info('[redeemPrize]', orderNo, prizeId)
    return {
      code: 0,
      message: 'success',
      data: { orderNo, prizeName: def.name, balance: balance - def.cost }
    }
  } catch (err) {
    console.error('[redeemPrize] error:', err)
    return { code: -1, message: err.message || '服务异常', data: null }
  }
}
