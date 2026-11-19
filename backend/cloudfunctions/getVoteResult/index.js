const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

function beijingDate(d) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function mapQuestion(q, today) {
  return {
    id: q._id,
    title: q.title,
    optionA: q.optionA,
    optionB: q.optionB,
    date: q.showDate || ''
  }
}

exports.main = async (event) => {
  try {
    const wxContext = cloud.getWXContext()
    const questionId = event.questionId
    if (!questionId) {
      return { code: -1, message: '缺少题目 ID', data: null }
    }
    const today = beijingDate(new Date())

    const qRes = await db.collection('questions').doc(questionId).get()
    const question = qRes.data
    if (!question || question.status !== 'published') {
      return { code: -1, message: '题目不存在或已下架', data: null }
    }

    const aRes = await db.collection('votes').where({ questionId, option: 'A' }).count()
    const bRes = await db.collection('votes').where({ questionId, option: 'B' }).count()
    const votesA = aRes.total
    const votesB = bRes.total

    // 我的选择（未答 / 被分享进入时为 null）
    let myOption = null
    const vRes = await db
      .collection('votes')
      .where({ _openid: wxContext.OPENID, questionId })
      .limit(1)
      .get()
    if (vRes.data.length > 0) {
      myOption = vRes.data[0].option
    }

    return {
      code: 0,
      message: 'success',
      data: {
        question: mapQuestion(question, today),
        votesA,
        votesB,
        total: votesA + votesB,
        myOption,
        isExpired: question.showDate !== today
      }
    }
  } catch (err) {
    console.error('[getVoteResult] error:', err)
    return { code: -1, message: err.message || '服务异常', data: null }
  }
}
