const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

/** getMySubmissions：我的投稿列表（状态：pending/approved/rejected） */
exports.main = async () => {
  try {
    const wxContext = cloud.getWXContext()
    const openid = wxContext.OPENID
    const res = await db
      .collection('submissions')
      .where({ _openid: openid })
      .orderBy('createTime', 'desc')
      .limit(50)
      .get()
    return {
      code: 0,
      message: 'success',
      data: (res.data || []).map((s) => ({
        id: s._id,
        title: s.title,
        optionA: s.optionA,
        optionB: s.optionB,
        signature: s.signature,
        status: s.status,
        showDate: s.showDate,
        rejectReason: s.rejectReason,
        createdAt: new Date(s.createTime).toISOString()
      }))
    }
  } catch (err) {
    console.error('[getMySubmissions] error:', err)
    return { code: -1, message: err.message || '服务异常', data: null }
  }
}
