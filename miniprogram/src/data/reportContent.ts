import type { ReportReason } from '@/types'
import { bumpCommentReport } from '@/services/storage'

interface ReportParams {
  targetType: 'question' | 'comment'
  targetId: string
  reason: ReportReason
  detail?: string
}

/** mock：reportContent —— 举报落库；短评举报累计 3 次自动隐藏（对应文档 8.1） */
export default function (data?: ReportParams): { ok: boolean } {
  const p = data || ({} as ReportParams)
  if (!p.targetId) {
    throw new Error('缺少举报对象')
  }
  console.info('[mock:reportContent]', p.targetType, p.targetId, p.reason, p.detail || '')
  if (p.targetType === 'comment') {
    bumpCommentReport(p.targetId)
  }
  return { ok: true }
}
