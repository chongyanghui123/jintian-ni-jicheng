const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

/**
 * 日期口径统一（文档 11.3）：云函数运行在 UTC，统一 +8h 换算北京时间。
 * 客户端不自己算日期，一切以本函数返回的 serverDate 为准。
 */
function beijingDate(d) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function mapQuestion(q) {
  if (!q) return null
  return {
    id: q._id,
    title: q.title,
    optionA: q.optionA,
    optionB: q.optionB,
    date: q.showDate || ''
  }
}

exports.main = async () => {
  try {
    const wxContext = cloud.getWXContext()
    const today = beijingDate(new Date())

    // 当日题：按 showDate 排期（运营在 questions 集合维护），当天不变
    const qRes = await db
      .collection('questions')
      .where({ showDate: today, status: 'published' })
      .limit(1)
      .get()
    const question = qRes.data[0] || null

    let answered = false
    let myOption = null
    let myDuration = 0
    if (question) {
      const vRes = await db
        .collection('votes')
        .where({ _openid: wxContext.OPENID, questionId: question._id })
        .limit(1)
        .get()
      if (vRes.data.length > 0) {
        answered = true
        myOption = vRes.data[0].option
        myDuration = vRes.data[0].duration || 0
      }
    }

    return {
      code: 0,
      message: 'success',
      data: {
        serverDate: today,
        question: mapQuestion(question),
        answered,
        myOption,
        myDuration
      }
    }
  } catch (err) {
    console.error('[getTodayQuestion] error:', err)
    return { code: -1, message: err.message || '服务异常', data: null }
  }
}
