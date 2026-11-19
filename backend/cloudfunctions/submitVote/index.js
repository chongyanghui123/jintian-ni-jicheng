const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 北京时间日期（票按题目所属日期入库，不按服务器当前日期——对应文档漏洞 #1）
function beijingDate(d) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 统计某题的 A/B 票数 */
async function countVotes(questionId) {
  const aRes = await db.collection('votes').where({ questionId, option: 'A' }).count()
  const bRes = await db.collection('votes').where({ questionId, option: 'B' }).count()
  return { votesA: aRes.total, votesB: bRes.total, total: aRes.total + bRes.total }
}

// ---- 积分发放（对应文档 6.2：仅服务端发放；答题 +2，连答 7 天 +10，日上限 60） ----
const POINTS_ANSWER = 2
const POINTS_STREAK7 = 10
const DAILY_CAP = 60

/** 今日已获得积分（北京时间当日零点起） */
async function earnedTodaySum(openid, today) {
  const start = new Date(`${today}T00:00:00+08:00`)
  const res = await db
    .collection('points_ledger')
    .where({ _openid: openid, type: 'earn', createTime: db.command.gte(start) })
    .limit(100)
    .get()
  return (res.data || []).reduce((s, e) => s + (e.amount || 0), 0)
}

/** 发放积分（幂等：同 refId 只发一次；流水只增不改） */
async function earnPoints(openid, amount, reason, refId, today) {
  if ((await earnedTodaySum(openid, today)) + amount > DAILY_CAP) {
    return false
  }
  const exist = await db
    .collection('points_ledger')
    .where({ _openid: openid, type: 'earn', refId })
    .limit(1)
    .get()
  if (exist.data.length > 0) {
    return false
  }
  await db.collection('points_ledger').add({
    data: {
      _openid: openid,
      type: 'earn',
      amount,
      reason,
      refId,
      createTime: new Date()
    }
  })
  return true
}

/** 连续答题天数（含今天）：票按 questionDate 统计 */
async function streakIncludingToday(openid, today) {
  const res = await db
    .collection('votes')
    .where({ _openid: openid })
    .limit(100)
    .get()
  const dates = new Set((res.data || []).map((v) => v.questionDate))
  let streak = 1
  let cursor = 1 // 从昨天（today - 1 天）往前数
  for (;;) {
    const d = new Date(new Date(`${today}T00:00:00+08:00`).getTime() - cursor * 24 * 3600 * 1000)
    const ds = d.toISOString().slice(0, 10)
    if (!dates.has(ds)) break
    streak += 1
    cursor += 1
  }
  return streak
}

exports.main = async (event) => {
  try {
    const wxContext = cloud.getWXContext()
    const openid = wxContext.OPENID
    const { questionId, option } = event
    const duration = Math.min(60, Math.max(0, Math.round(event.duration || 0)))

    if (!questionId || (option !== 'A' && option !== 'B')) {
      return { code: -1, message: '参数错误', data: null }
    }

    const today = beijingDate(new Date())

    // 题目校验：必须存在且已发布
    const qRes = await db.collection('questions').doc(questionId).get()
    const question = qRes.data
    if (!question || question.status !== 'published') {
      return { code: -1, message: '题目不存在或已下架', data: null }
    }

    // 跨零点保护：只接受今天的题（对应文档漏洞 #1）
    if (question.showDate !== today) {
      return { code: -1, message: '今天已经换题了', data: null }
    }

    // 幂等：一人一题一票（对应文档"投票幂等"底线）
    const existRes = await db
      .collection('votes')
      .where({ _openid: openid, questionId })
      .limit(1)
      .get()
    if (existRes.data.length > 0) {
      const stats = await countVotes(questionId)
      return {
        code: 0,
        message: 'success',
        data: { ...stats, myOption: existRes.data[0].option }
      }
    }

    await db.collection('votes').add({
      data: {
        questionId,
        questionDate: question.showDate, // 票按题目所属日期入库
        option,
        duration,
        createTime: db.serverDate()
      }
    })
    console.info('[submitVote]', questionId, option, 'duration:', duration)

    // ---- 投票成功后发放积分（服务端发放，幂等） ----
    let earnedPoints = 0
    let earnedReason
    try {
      if (await earnPoints(openid, POINTS_ANSWER, '每日答题', questionId, today)) {
        earnedPoints += POINTS_ANSWER
        earnedReason = '每日答题'
      }
      const streak = await streakIncludingToday(openid, today)
      if (streak > 0 && streak % 7 === 0) {
        const cycleStart = new Date(
          new Date(`${today}T00:00:00+08:00`).getTime() - (streak - 1) * 24 * 3600 * 1000
        )
          .toISOString()
          .slice(0, 10)
        if (await earnPoints(openid, POINTS_STREAK7, '连续答题 7 天奖励', `streak7-${cycleStart}`, today)) {
          earnedPoints += POINTS_STREAK7
          earnedReason = earnedReason ? `${earnedReason} + 连答 7 天奖励` : '连答 7 天奖励'
        }
      }
    } catch (ptsErr) {
      // 发分失败不影响投票主流程
      console.error('[submitVote] earnPoints failed:', ptsErr)
    }

    const stats = await countVotes(questionId)
    return {
      code: 0,
      message: 'success',
      data: { ...stats, myOption: option, earnedPoints, earnedReason }
    }
  } catch (err) {
    console.error('[submitVote] error:', err)
    return { code: -1, message: err.message || '服务异常', data: null }
  }
}
