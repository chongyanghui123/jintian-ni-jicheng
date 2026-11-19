const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

function beijingDate(d) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

exports.main = async () => {
  try {
    const wxContext = cloud.getWXContext()
    const today = beijingDate(new Date())
    const yesterday = beijingDate(new Date(Date.now() - 24 * 3600 * 1000))

    const qRes = await db
      .collection('questions')
      .where({ showDate: yesterday, status: 'published' })
      .limit(1)
      .get()
    const question = qRes.data[0] || null
    if (!question) {
      return { code: 0, message: 'success', data: null }
    }

    const aRes = await db.collection('votes').where({ questionId: question._id, option: 'A' }).count()
    const bRes = await db.collection('votes').where({ questionId: question._id, option: 'B' }).count()
    const votesA = aRes.total
    const votesB = bRes.total

    let myOption = null
    const vRes = await db
      .collection('votes')
      .where({ _openid: wxContext.OPENID, questionId: question._id })
      .limit(1)
      .get()
    if (vRes.data.length > 0) {
      myOption = vRes.data[0].option
    }

    return {
      code: 0,
      message: 'success',
      data: {
        date: yesterday,
        question: {
          id: question._id,
          title: question.title,
          optionA: question.optionA,
          optionB: question.optionB,
          date: question.showDate || yesterday
        },
        votesA,
        votesB,
        total: votesA + votesB,
        myOption
      }
    }
  } catch (err) {
    console.error('[getYesterdayResult] error:', err)
    return { code: -1, message: err.message || '服务异常', data: null }
  }
}
