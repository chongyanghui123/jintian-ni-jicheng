// 云函数：每日 08:00 定时下发「新题上墙」订阅提醒（一次性订阅，发送后记录置 off）
// 部署：云开发控制台上传本函数并在「触发器」里启用 config.json 的 dailyNotifyTrigger，
// 或用云开发 CLI：tcb fn deploy dailyNotify --triggers config.json
// 模板 ID：微信公众平台申请「订阅消息」一次性模板后，在云函数环境变量 NOTIFY_TMPL_ID 配置
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 模板 ID 也可写死在常量里（环境变量优先）
const TEMPLATE_ID = process.env.NOTIFY_TMPL_ID || ''

/** 云函数运行在 UTC，统一 +8h 换算北京时间（口径同 getTodayQuestion 文档 11.3） */
function beijingDate(d) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

exports.main = async () => {
  if (!TEMPLATE_ID) {
    return { code: 0, message: 'template id not configured, skip', data: null }
  }
  try {
    const today = beijingDate(new Date())

    // 当日上墙题：与 getTodayQuestion 同口径（showDate=today 且已上架）
    const qRes = await db
      .collection('questions')
      .where({ showDate: today, status: 'published' })
      .limit(1)
      .get()
    const q = qRes.data && qRes.data[0]
    if (!q) {
      return { code: 0, message: 'no question today, skip', data: null }
    }

    // 有效订阅者（status=on 且 7 天内授权——过期授权不再尝试）
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000
    const subs = await db
      .collection('notify_subs')
      .where({ status: 'on', updatedAt: _.gte(weekAgo) })
      .limit(100)
      .get()

    let sent = 0
    for (const s of subs.data) {
      try {
        await cloud.openapi.subscribeMessage.send({
          touser: s._id,
          templateId: TEMPLATE_ID,
          page: 'pages/today/index',
          miniprogramState: 'formal',
          data: {
            // 字段名按申请到的模板字段调整；thing 类型最长 20 字
            thing1: { value: (q.title || '').slice(0, 20) },
            thing2: { value: '今日新题已上墙，来站个队' }
          }
        })
        sent += 1
        // 一次性订阅：发送成功即失效
        await db.collection('notify_subs').doc(s._id).update({ data: { status: 'off', updatedAt: Date.now() } })
      } catch (e) {
        // 43101 用户未订阅/已拒收：置 off 避免无效重试；其余错误跳过该用户
        if (e.errCode === 43101) {
          await db.collection('notify_subs').doc(s._id).update({ data: { status: 'off', updatedAt: Date.now() } })
        } else {
          console.error('[dailyNotify] send failed:', s._id, e.errCode, e.errMsg)
        }
      }
    }
    return { code: 0, message: `sent ${sent}/${subs.data.length}`, data: null }
  } catch (e) {
    console.error('[dailyNotify] failed:', e)
    return { code: 1, message: e.message, data: null }
  }
}
