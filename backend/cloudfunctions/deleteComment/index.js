const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

/**
 * deleteComment：撤回自己的短评（对应 V1.7 修订：不可改，开 5 分钟撤回窗口）。
 * 仅本人；超过 5 分钟拒绝；物理删除。
 */
exports.main = async (event) => {
  try {
    const wxContext = cloud.getWXContext()
    const openid = wxContext.OPENID
    const { commentId } = event
    if (!commentId) {
      return { code: -1, message: '参数错误', data: null }
    }
    const res = await db.collection('comments').doc(commentId).get()
    const c = res.data
    if (!c || c._openid !== openid) {
      return { code: -1, message: '只能撤回自己的短评', data: null }
    }
    const created = new Date(c.createTime).getTime()
    if (Date.now() - created > 5 * 60 * 1000) {
      return { code: -1, message: '已超过 5 分钟，不能删除了', data: null }
    }
    await db.collection('comments').doc(commentId).remove()
    return { code: 0, message: 'success', data: { ok: true } }
  } catch (err) {
    console.error('[deleteComment] error:', err)
    return { code: -1, message: err.message || '服务异常', data: null }
  }
}
