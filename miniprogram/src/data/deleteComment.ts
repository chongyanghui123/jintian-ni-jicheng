import { deleteLocalComment } from '@/services/storage'

interface DeleteCommentParams {
  commentId: string
}

/** mock：deleteComment —— 仅本人、5 分钟内可删（不可改；删除即放弃该条） */
export default function (data?: DeleteCommentParams): { ok: boolean } {
  const { commentId } = data || ({} as DeleteCommentParams)
  if (!commentId) {
    throw new Error('参数错误')
  }
  const ok = deleteLocalComment(commentId)
  if (!ok) {
    throw new Error('已超过 5 分钟，不能删除了')
  }
  return { ok: true }
}
