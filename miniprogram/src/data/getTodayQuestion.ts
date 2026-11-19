import Taro from '@tarojs/taro'
import type { AnswerRecord, TodayQuestionResult } from '@/types'
import { getQuestionByDate } from './questions'
import { getTodayDate } from '@/utils/date'

/** mock：getTodayQuestion —— 今日题 + 我是否已答（读本地记录） */
export default function (): TodayQuestionResult {
  const today = getTodayDate()
  const question = getQuestionByDate(today)
  let answered = false
  let myOption: 'A' | 'B' | null = null
  let myDuration = 0
  try {
    const records: AnswerRecord[] = Taro.getStorageSync('jc_answer_records') || []
    const hit = Array.isArray(records) ? records.find((r) => r.questionId === question.id) : null
    if (hit) {
      answered = true
      myOption = hit.myOption
      myDuration = hit.duration
    }
  } catch (err) {
    console.error('[mock:getTodayQuestion] read records failed:', err)
  }
  console.info('[mock:getTodayQuestion]', question.id, 'answered:', answered)
  return { serverDate: today, question, answered, myOption, myDuration }
}
