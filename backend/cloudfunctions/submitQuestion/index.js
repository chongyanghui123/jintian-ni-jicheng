const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

/** 简单机审词表（正式接入内容安全 API 后替换；对应文档 4.2"机审+人审"） */
const BLOCK_WORDS = ['加微信', '加v', '转账', '赌博', '裸', '约炮', '官方', '客服', '管理员']
const DAILY_LIMIT = 3

// 北京时间日期
function beijingDate(d) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/**
 * submitQuestion：投稿题目（对应文档 4.2）：
 * 题干 4-40 字、选项 1-16 字、两选项不实质相同、每天 3 道、
 * 署名 2-8 字（留空"网友投稿"）、机审通过后进 pending 等人工审核。
 * 硬规则：00:00 冻结当日题，投稿只能进次日起的题池（由审核侧安排）。
 */
exports.main = async (event) => {
  try {
    const wxContext = cloud.getWXContext()
    const openid = wxContext.OPENID
    const title = (event.title || '').trim()
    const optionA = (event.optionA || '').trim()
    const optionB = (event.optionB || '').trim()
    const signature = (event.signature || '').trim()

    if (title.length < 4 || title.length > 40) {
      return { code: -1, message: '题干需 4~40 字', data: null }
    }
    if (optionA.length < 1 || optionA.length > 16) {
      return { code: -1, message: '选项 A 需 1~16 字', data: null }
    }
    if (optionB.length < 1 || optionB.length > 16) {
      return { code: -1, message: '选项 B 需 1~16 字', data: null }
    }
    if (optionA === optionB) {
      return { code: -1, message: '两个选项不能实质相同', data: null }
    }
    if (signature && (signature.length < 2 || signature.length > 8)) {
      return { code: -1, message: '署名需 2~8 字', data: null }
    }
    const all = title + optionA + optionB + signature
    if (BLOCK_WORDS.some((w) => all.includes(w))) {
      return { code: -1, message: '内容含违规词，改一下再投', data: null }
    }
    // 每天 3 道（北京时间自然日）
    const today = beijingDate(new Date())
    const dayStart = new Date(`${today}T00:00:00+08:00`)
    const countRes = await db
      .collection('submissions')
      .where({ _openid: openid, createTime: db.command.gte(dayStart) })
      .count()
    if (countRes.total >= DAILY_LIMIT) {
      return { code: -1, message: '今天已经投了 3 道，明天再来', data: null }
    }

    const res = await db.collection('submissions').add({
      data: {
        _openid: openid,
        title,
        optionA,
        optionB,
        signature,
        status: 'pending', // 机审通过，等人工审核
        showDate: null,
        rejectReason: null,
        createTime: db.serverDate()
      }
    })
    console.info('[submitQuestion]', res._id, title.slice(0, 10))
    return {
      code: 0,
      message: 'success',
      data: {
        id: res._id,
        title,
        optionA,
        optionB,
        signature,
        status: 'pending',
        createdAt: new Date().toISOString()
      }
    }
  } catch (err) {
    console.error('[submitQuestion] error:', err)
    return { code: -1, message: err.message || '服务异常', data: null }
  }
}
