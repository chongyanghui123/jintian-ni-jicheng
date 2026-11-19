const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

/** 首期 3 个虚拟品（文档 6.3；"加更权"按 V1.7 修订替换为往期回看券） */
const DEFAULT_PRIZES = [
  {
    id: 'p_title',
    name: '专属称号「清醒人」',
    desc: '展示在「我的」页面，仅答过题的人能懂',
    cost: 100,
    stock: 100,
    monthlyLimit: 1
  },
  {
    id: 'p_relook',
    name: '往期回看券',
    desc: '解锁一道往期题的完整结果与占比',
    cost: 200,
    stock: 50,
    monthlyLimit: 1
  },
  {
    id: 'p_skin',
    name: '限定皮肤「夜航」',
    desc: '结果页专属配色，30 天',
    cost: 300,
    stock: 20,
    monthlyLimit: 1
  }
]

/** getPrizes：商品列表；库存 = 初始库存 - 已兑总数，0 库存自动下架（文档 8.3） */
exports.main = async () => {
  try {
    const wxContext = cloud.getWXContext()
    const openid = wxContext.OPENID
    const month = new Date().toISOString().slice(0, 7)

    const prizesRes = await db.collection('prizes').limit(20).get()
    const defs = (prizesRes.data && prizesRes.data.length > 0
      ? prizesRes.data.map((p) => ({
          id: p._id,
          name: p.name,
          desc: p.desc || '',
          cost: p.cost,
          stock: typeof p.stock === 'number' ? p.stock : p.initialStock || 0,
          monthlyLimit: p.monthlyLimit || 1,
          initialStock: typeof p.stock === 'number' ? p.stock : p.initialStock || 0
        }))
      : DEFAULT_PRIZES.map((p) => ({ ...p, initialStock: p.stock })))

    // 全局已兑数量（按订单统计，状态 done）
    const ordersRes = await db
      .collection('redeem_orders')
      .where({ status: 'done' })
      .limit(1000)
      .get()
    const usedMap = {}
    for (const o of ordersRes.data || []) {
      usedMap[o.prizeId] = (usedMap[o.prizeId] || 0) + 1
    }

    // 我本月已兑次数
    const myRes = await db
      .collection('redeem_orders')
      .where({ _openid: openid, status: 'done' })
      .limit(1000)
      .get()
    const myMonthMap = {}
    for (const o of myRes.data || []) {
      const om = new Date(o.createTime).toISOString().slice(0, 7)
      if (om === month) {
        myMonthMap[o.prizeId] = (myMonthMap[o.prizeId] || 0) + 1
      }
    }

    const data = defs.map((p) => ({
      id: p.id,
      name: p.name,
      desc: p.desc,
      cost: p.cost,
      stock: Math.max(0, (p.initialStock || 0) - (usedMap[p.id] || 0)),
      monthlyLimit: p.monthlyLimit,
      redeemedThisMonth: myMonthMap[p.id] || 0
    }))

    return { code: 0, message: 'success', data }
  } catch (err) {
    console.error('[getPrizes] error:', err)
    return { code: -1, message: err.message || '服务异常', data: null }
  }
}
