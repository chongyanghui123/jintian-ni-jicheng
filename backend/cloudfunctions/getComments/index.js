const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

/**
 * getComments：短评列表（对应文档 4.3）。
 * 服务端门禁：必须已答该题（votes 有记录）才返回，否则 locked=true 不给任何评论。
 * 对立面软配额：一条对立面短评置顶并标"对面的理由"，没有不强补。
 */
exports.main = async (event) => {
  try {
    const wxContext = cloud.getWXContext()
    const openid = wxContext.OPENID
    const { questionId, myOption } = event
    if (!questionId) {
      return { code: -1, message: '参数错误', data: null }
    }
    // 门禁：查 votes（服务端判定，不信客户端）
    const voted = await db
      .collection('votes')
      .where({ _openid: openid, questionId })
      .limit(1)
      .get()
    if (voted.data.length === 0) {
      return { code: 0, message: 'success', data: { locked: true, comments: [], mine: null, total: 0 } }
    }
    const myOpt = voted.data[0].option

    // 未隐藏的评论（机审即发；3 举报自动隐藏后不再返回）
    const res = await db
      .collection('comments')
      .where({ questionId, hidden: false })
      .orderBy('createTime', 'asc')
      .limit(20)
      .get()
    const all = (res.data || []).map((c) => ({
      id: c._id,
      questionId: c.questionId,
      option: c.option,
      content: c.content,
      isMine: c._openid === openid,
      createdAt: new Date(c.createTime).toISOString()
    }))
    const mine = all.find((c) => c.isMine) || null
    const others = all.filter((c) => !c.isMine)
    const opposite = others.filter((c) => c.option !== myOpt)
    const sameSide = others.filter((c) => c.option === myOpt)
    const ordered = [...opposite.slice(0, 1), ...sameSide, ...opposite.slice(1)].map((c, i) => ({
      ...c,
      isOppositeTop: i === 0 && opposite.length > 0
    }))
    return {
      code: 0,
      message: 'success',
      data: { locked: false, comments: ordered, mine, total: ordered.length }
    }
  } catch (err) {
    console.error('[getComments] error:', err)
    return { code: -1, message: err.message || '服务异常', data: null }
  }
}
