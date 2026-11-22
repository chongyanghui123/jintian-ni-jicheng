// 云函数：记录订阅消息授权状态（一次性订阅，下发一次即失效）
// 集合 notify_subs：文档 _id = openid，字段 status('on'/'off')、updatedAt
// 小程序端在用户点击答题时同步调用 requestSubscribeMessage，accept 后上报本函数
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'subscribe'
  const status = action === 'subscribe' ? 'on' : 'off'
  try {
    await db.collection('notify_subs').doc(OPENID).set({
      data: { status, updatedAt: Date.now() }
    })
    return { code: 0, message: 'ok', data: null }
  } catch (e) {
    console.error('[subscribeNotify] failed:', e)
    return { code: 1, message: e.message, data: null }
  }
}
