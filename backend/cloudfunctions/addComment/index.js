const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

/** 简单机审词表（正式接入内容安全 API 后替换；对应文档 4.3"机审即发"） */
const BLOCK_WORDS = ['加微信', '加v', '转账', '赌博', '裸', '约炮', '代购', '兼职']

/**
 * addComment：发短评（对应文档 4.3）：
 * 答过才能发（服务端查 votes）、40 字内、机审即发、每人每题一条、不可改（5 分钟内可删走 deleteComment）。
 */
exports.main = async (event) => {
  try {
    const wxContext = cloud.getWXContext()
    const openid = wxContext.OPENID
    const { questionId, option } = event
    const content = (event.content || '').trim()
    if (!questionId || (option !== 'A' && option !== 'B') || !content) {
      return { code: -1, message: '参数错误', data: null }
    }
    if (content.length > 40) {
      return { code: -1, message: '最多 40 字', data: null }
    }
    const lower = content.toLowerCase()
    if (BLOCK_WORDS.some((w) => lower.includes(w))) {
      return { code: -1, message: '内容含违规词，改一下再发', data: null }
    }
    // 门禁：答过该题才能发
    const voted = await db
      .collection('votes')
      .where({ _openid: openid, questionId })
      .limit(1)
      .get()
    if (voted.data.length === 0) {
      return { code: -1, message: '答完今天这题才能写短评', data: null }
    }
    // 每人每题一条
    const exist = await db
      .collection('comments')
      .where({ _openid: openid, questionId, hidden: false })
      .limit(1)
      .get()
    if (exist.data.length > 0) {
      return { code: -1, message: '每题只能写一条短评', data: null }
    }
    const res = await db.collection('comments').add({
      data: {
        _openid: openid,
        questionId,
        option,
        content,
        reportCount: 0,
        hidden: false,
        createTime: db.serverDate()
      }
    })
    console.info('[addComment]', questionId, option, content.slice(0, 10))
    return {
      code: 0,
      message: 'success',
      data: {
        id: res._id,
        questionId,
        option,
        content,
        isMine: true,
        createdAt: new Date().toISOString()
      }
    }
  } catch (err) {
    console.error('[addComment] error:', err)
    return { code: -1, message: err.message || '服务异常', data: null }
  }
}
