import Taro from '@tarojs/taro'
import type { AnswerRecord, OptionKey, Question, VoteResultData } from '@/types'
import { QUESTIONS, getQuestionByDate, mockVotesFor } from './questions'
import { getTodayDate } from '@/utils/date'

/** mock：getVoteResult —— 占比统计 + 是否过期 + 我的选择（无记录时为 null） */
export default function (data?: { questionId?: string }): VoteResultData {
  const questionId = data && data.questionId
  if (!questionId) {
    throw new Error('缺少题目 ID')
  }
  const today = getTodayDate()
  // 今日题按日期轮换；往期题在题库中按 id 找回
  const question: Question =
    QUESTIONS.find((q) => q.id === questionId) || getQuestionByDate(today)
  const base = mockVotesFor(question.id)
  let myOption: OptionKey | null = null
  try {
    const records: AnswerRecord[] = Taro.getStorageSync('jc_answer_records') || []
    const hit = Array.isArray(records) ? records.find((r) => r.questionId === question.id) : null
    if (hit) myOption = hit.myOption
  } catch (err) {
    console.error('[mock:getVoteResult] read records failed:', err)
  }
  const isMine = question.id === getQuestionByDate(today).id
  const votesA = base.votesA + (myOption === 'A' ? 1 : 0)
  const votesB = base.votesB + (myOption === 'B' ? 1 : 0)
  console.info('[mock:getVoteResult]', question.id, 'total:', votesA + votesB)
  return {
    question: { ...question, date: isMine ? today : question.date || today },
    votesA,
    votesB,
    total: votesA + votesB,
    myOption,
    isExpired: !isMine
  }
}
