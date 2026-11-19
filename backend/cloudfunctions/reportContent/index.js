const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const VALID_REASONS = ['low_quality', 'inappropriate', 'violation', 'other']

/** 举报落库（最小版）：不回执页、不做流程，后台可查即可 */
exports.main = async (event) => {
  try {
    const wxContext = cloud.getWXContext()
    const { targetType, targetId, reason, detail } = event
    if (!targetId || VALID_REASONS.indexOf(reason) < 0) {
      return { code: -1, message: '参数错误', data: null }
    }
    await db.collection('reports').add({
      data: {
        targetType: targetType === 'comment' ? 'comment' : 'question',
        targetId,
        reason,
        detail: (detail || '').slice(0, 40),
        status: 'open',
        createTime: db.serverDate()
      }
    })
    // 短评举报：累计 3 次自动隐藏（对应文档 8.1"3 次举报自动隐藏"）
    if (targetType === 'comment') {
      const cRes = await db.collection('comments').doc(targetId).get()
      if (cRes.data) {
        const count = (cRes.data.reportCount || 0) + 1
        const update = { reportCount: count }
        if (count >= 3) update.hidden = true
        await db.collection('comments').doc(targetId).update({ data: update })
        console.info('[reportContent] comment reportCount:', count, 'hidden:', count >= 3)
      }
    }
    console.info('[reportContent]', targetType, targetId, reason)
    return { code: 0, message: 'success', data: { ok: true } }
  } catch (err) {
    console.error('[reportContent] error:', err)
    return { code: -1, message: err.message || '服务异常', data: null }
  }
}
