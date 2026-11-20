import Taro from '@tarojs/taro'
import type { AnswerRecord, OptionKey, VoteStats } from '@/types'
import { getQuestionByDate, mockVotesFor } from './questions'
import { POINTS_RULES } from './points'
import { getTodayDate, getDateOffset } from '@/utils/date'
import { earnPoints, getEarnedToday } from '@/services/storage'

interface SubmitVoteParams {
  questionId: string
  option: OptionKey
  duration: number
}

/**
 * 连续答题天数（含今天，mock 侧今天记录由页面在投票后写入，
 * 此处按"截至昨天"的连续天数 + 1 计算）。
 */
function streakIncludingToday(records: AnswerRecord[]): number {
  const dates = new Set(Array.isArray(records) ? records.map((r) => r.date) : [])
  let streak = 1
  let cursor = -1 // 从昨天往前数
  while (dates.has(getDateOffset(getTodayDate(), cursor))) {
    streak += 1
    cursor -= 1
  }
  return streak
}

/** mock：submitVote —— 幂等提交（已答不重复计票），票按题目所属日期入库；答后服务端发放积分 */
export default function (data?: SubmitVoteParams): VoteStats {
  const params = data || ({} as SubmitVoteParams)
  const { questionId, option } = params
  const duration = Math.min(60, Math.max(0, Math.round(params.duration || 0)))
  if (!questionId || (option !== 'A' && option !== 'B')) {
    throw new Error('参数错误')
  }
  const question = getQuestionByDate(getTodayDate())
  if (question.id !== questionId) {
    // 跨零点保护：提交的题已不是今天的题
    throw new Error('今天已经换题了')
  }
  try {
    const records: AnswerRecord[] = Taro.getStorageSync('jc_answer_records') || []
    const already = Array.isArray(records)
      ? records.find((r) => r.questionId === questionId)
      : null
    const base = mockVotesFor(questionId)
    if (already) {
      // 幂等：直接返回当前统计，不重复计票、不重复发分
      return {
        votesA: base.votesA + (already.myOption === 'A' ? 1 : 0),
        votesB: base.votesB + (already.myOption === 'B' ? 1 : 0),
        total: base.votesA + base.votesB + 1,
        myOption: already.myOption
      }
    }
    const votesA = base.votesA + (option === 'A' ? 1 : 0)
    const votesB = base.votesB + (option === 'B' ? 1 : 0)
    console.info('[mock:submitVote]', questionId, option, 'duration:', duration)

    // ---- 积分发放（仅数据层发放，页面不可写入；流水只增） ----
    let earnedPoints = 0
    let earnedReason: string | undefined
    if (getEarnedToday() + POINTS_RULES.ANSWER <= POINTS_RULES.DAILY_CAP
        && earnPoints(POINTS_RULES.ANSWER, '每日答题', questionId)) {
      earnedPoints += POINTS_RULES.ANSWER
      earnedReason = '每日答题'
    }
    const streak = streakIncludingToday(records)
    if (streak > 0 && streak % 7 === 0) {
      // 每满 7 天发一次；幂等键 = 周期起点日期
      const cycleStart = getDateOffset(getTodayDate(), -(streak - 1))
      if (getEarnedToday() + POINTS_RULES.STREAK7 <= POINTS_RULES.DAILY_CAP
          && earnPoints(POINTS_RULES.STREAK7, '连续答题 7 天奖励', `streak7-${cycleStart}`)) {
        earnedPoints += POINTS_RULES.STREAK7
        earnedReason = earnedReason
          ? `${earnedReason} + 连答 7 天奖励`
          : '连答 7 天奖励'
      }
    }

    return {
      votesA,
      votesB,
      total: votesA + votesB,
      myOption: option,
      earnedPoints,
      earnedReason
    }
  } catch (err) {
    console.error('[mock:submitVote] failed:', err)
    throw err
  }
}
