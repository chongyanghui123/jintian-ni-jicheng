import Taro from '@tarojs/taro'
import type { AnswerRecord, OptionKey, RevealData } from '@/types'
import { getQuestionByDate, mockVotesFor } from './questions'
import { getTodayDate, getDateOffset } from '@/utils/date'

/** mock：getYesterdayResult —— 昨日题 + 最终占比 + 我的选择 */
export default function (): RevealData {
  const today = getTodayDate()
  const yesterday = getDateOffset(today, -1)
  const question = getQuestionByDate(yesterday)
  const base = mockVotesFor(question.id)
  let myOption: OptionKey | null = null
  try {
    const records: AnswerRecord[] = Taro.getStorageSync('jc_answer_records') || []
    const hit = Array.isArray(records) ? records.find((r) => r.questionId === question.id) : null
    if (hit) myOption = hit.myOption
  } catch (err) {
    console.error('[mock:getYesterdayResult] read records failed:', err)
  }
  const votesA = base.votesA + (myOption === 'A' ? 1 : 0)
  const votesB = base.votesB + (myOption === 'B' ? 1 : 0)
  console.info('[mock:getYesterdayResult]', question.id)
  return { date: yesterday, question, votesA, votesB, total: votesA + votesB, myOption }
}
