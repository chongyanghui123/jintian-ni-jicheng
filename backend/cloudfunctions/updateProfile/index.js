const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext()
    const nickname = String(event.nickname || '').trim().slice(0, 20)
    // add 或 update：不存在则建档（doc id = OPENID）
    try {
      await db.collection('users').doc(OPENID).update({ data: { nickname, updated_at: Date.now() } })
    } catch (e) {
      await db.collection('users').add({ data: { _id: OPENID, nickname, avatar: '', status: 'active', created_at: Date.now(), updated_at: Date.now() } })
    }
    return { code: 0, message: 'success', data: { nickname } }
  } catch (err) {
    console.error('[updateProfile] error:', err)
    return { code: -1, message: err.message || '服务异常', data: null }
  }
}
