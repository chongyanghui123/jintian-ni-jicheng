import type { Submission } from '@/types'
import { addSubmission, countSubmissionsToday } from '@/services/storage'

interface SubmitQuestionParams {
  title: string
  optionA: string
  optionB: string
  signature?: string
}

/** 简单机审词表（正式接入内容安全 API 后替换；对应文档 4.2"机审+人审"） */
const BLOCK_WORDS = ['加微信', '加v', '转账', '赌博', '裸', '约炮', '官方', '客服', '管理员']

/**
 * mock：submitQuestion —— 校验链（对应文档 4.2）：
 * 题干 4-40 字、选项 1-16 字、两选项不实质相同、每天 3 道、署名 2-8 字（留空"网友投稿"）。
 */
export default function (data?: SubmitQuestionParams): Submission {
  const { title, optionA, optionB, signature } = data || ({} as SubmitQuestionParams)
  const t = (title || '').trim()
  const a = (optionA || '').trim()
  const b = (optionB || '').trim()
  const sig = (signature || '').trim()

  if (t.length < 4 || t.length > 40) {
    throw new Error('题干需 4~40 字')
  }
  if (a.length < 1 || a.length > 16) {
    throw new Error('选项 A 需 1~16 字')
  }
  if (b.length < 1 || b.length > 16) {
    throw new Error('选项 B 需 1~16 字')
  }
  if (a === b) {
    throw new Error('两个选项不能实质相同')
  }
  if (sig && (sig.length < 2 || sig.length > 8)) {
    throw new Error('署名需 2~8 字')
  }
  const hit = BLOCK_WORDS.find(
    (w) => t.includes(w) || a.includes(w) || b.includes(w) || sig.includes(w)
  )
  if (hit) {
    throw new Error('内容含违规词，改一下再投')
  }
  const todayCount = countSubmissionsToday()
  if (todayCount >= 3) {
    throw new Error('今天已经投了 3 道，明天再来')
  }

  const sub: Submission = {
    id: `s${Date.now()}${Math.floor(Math.random() * 1000)}`,
    title: t,
    optionA: a,
    optionB: b,
    signature: sig,
    status: 'pending',
    createdAt: new Date().toISOString()
  }
  addSubmission(sub)
  console.info('[mock:submitQuestion]', sub.id, t.slice(0, 10))
  return sub
}
