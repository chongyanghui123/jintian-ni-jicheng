import type { CommentsData, OptionKey } from '@/types'
import { getCommentsByQuestion } from '@/services/storage'

interface GetCommentsParams {
  questionId: string
  myOption?: OptionKey | null
}

/**
 * mock：getComments —— 服务端门禁（对应文档 4.3）：未答该题不可读（locked=true）。
 * 对立面软配额：有一条对立面短评时置顶并标"对面的理由"，没有不强补。
 */
export default function (data?: GetCommentsParams): CommentsData {
  const { questionId, myOption } = data || ({} as GetCommentsParams)
  if (!questionId) {
    throw new Error('参数错误')
  }
  if (!myOption) {
    // 答过才能读：未答不返回任何评论
    return { locked: true, comments: [], mine: null, total: 0 }
  }
  const all = getCommentsByQuestion(questionId)
  const mine = all.find((c) => c.isMine) || null
  const others = all.filter((c) => !c.isMine)

  // 软配额：对立面置顶（有才置，没有不强补）
  const opposite = others.filter((c) => c.option !== myOption)
  const sameSide = others.filter((c) => c.option === myOption)
  const ordered = [...opposite.slice(0, 1), ...sameSide, ...opposite.slice(1)].map((c, i) => ({
    ...c,
    isOppositeTop: i === 0 && opposite.length > 0
  }))

  return { locked: false, comments: ordered, mine, total: ordered.length }
}
