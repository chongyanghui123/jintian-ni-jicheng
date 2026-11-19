import type { Submission } from '@/types'
import { getSubmissions } from '@/services/storage'

/** mock：getMySubmissions —— 我的投稿列表（状态：待审核/已通过/已驳回） */
export default function (): Submission[] {
  return getSubmissions()
}
