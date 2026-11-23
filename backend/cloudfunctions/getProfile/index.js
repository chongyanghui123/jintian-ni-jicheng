const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async () => {
  try {
    const { OPENID } = cloud.getWXContext()
    try {
      const doc = await db.collection('users').doc(OPENID).get()
      const u = doc.data || {}
      return {
        code: 0, message: 'success',
        data: {
          id: OPENID,
          nickname: u.nickname || '',
          avatar: u.avatar || '',
          status: u.status || 'active'
        }
      }
    } catch (e) {
      // 档案不存在：返回空资料（前端显示默认头像/占位昵称）
      return { code: 0, message: 'success', data: { id: OPENID, nickname: '', avatar: '', status: 'active' } }
    }
  } catch (err) {
    console.error('[getProfile] error:', err)
    return { code: -1, message: err.message || '服务异常', data: null }
  }
}
