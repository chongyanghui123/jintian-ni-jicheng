import type { CommentItem, OptionKey } from '@/types'
import { getCommentsByQuestion, addLocalComment, hasAnsweredToday } from '@/services/storage'

interface AddCommentParams {
  questionId: string
  option: OptionKey
  content: string
}

/** 简单机审词表（正式接入内容安全 API 后替换；对应文档 4.3"机审即发"） */
const BLOCK_WORDS = ['加微信', '加v', '转账', '赌博', '裸', '约炮', '代购', '兼职']

/** mock：addComment —— 40 字内、机审即发、每人每题一条、答过才能发 */
export default function (data?: AddCommentParams): CommentItem {
  const { questionId, option, content } = data || ({} as AddCommentParams)
  const text = (content || '').trim()
  if (!questionId || (option !== 'A' && option !== 'B')) {
    throw new Error('参数错误')
  }
  if (!text) {
    throw new Error('写点什么再发')
  }
  if (text.length > 40) {
    throw new Error('最多 40 字')
  }
  const hit = BLOCK_WORDS.find((w) => text.toLowerCase().includes(w))
  if (hit) {
    throw new Error('内容含违规词，改一下再发')
  }
  // 门禁：答过今天这题才能发（对应文档 4.3"答过才能读/写"）
  if (!hasAnsweredToday()) {
    throw new Error('答完今天这题才能写短评')
  }
  // 每人每题一条
  if (getCommentsByQuestion(questionId).some((c) => c.isMine)) {
    throw new Error('每题只能写一条短评')
  }
  const comment: CommentItem = {
    id: `c${Date.now()}${Math.floor(Math.random() * 1000)}`,
    questionId,
    option,
    content: text,
    isMine: true,
    createdAt: new Date().toISOString()
  }
  addLocalComment(comment)
  console.info('[mock:addComment]', questionId, option, text.slice(0, 10))
  return comment
}
