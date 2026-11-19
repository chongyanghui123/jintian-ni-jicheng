import { callFunction } from './cloud'
import type {
  AiProfile,
  CommentItem,
  CommentsData,
  OptionKey,
  PointsSummary,
  Prize,
  RedeemResult,
  ReportReason,
  RevealData,
  Submission,
  TodayQuestionResult,
  VoteResultData,
  VoteStats
} from '@/types'

/** 业务 API 封装：微信走云函数，H5 预览自动走 mock */
export const api = {
  /** 今日题 + 我是否已答 */
  getTodayQuestion(): Promise<TodayQuestionResult> {
    return callFunction<TodayQuestionResult>('getTodayQuestion')
  },

  /** 提交投票（服务端幂等 + 跨零点校验） */
  submitVote(params: { questionId: string; option: OptionKey; duration: number }): Promise<VoteStats> {
    return callFunction<VoteStats>('submitVote', params)
  },

  /** 占比统计 */
  getVoteResult(questionId: string): Promise<VoteResultData> {
    return callFunction<VoteResultData>('getVoteResult', { questionId })
  },

  /** AI 侧写 */
  getAiProfile(params: {
    questionId: string
    option: OptionKey
    duration: number
    ratio: number
  }): Promise<AiProfile> {
    return callFunction<AiProfile>('getAiProfile', params)
  },

  /** 昨日揭晓 */
  getYesterdayResult(): Promise<RevealData> {
    return callFunction<RevealData>('getYesterdayResult')
  },

  /** 举报（最小版） */
  reportContent(params: {
    targetType: 'question' | 'comment'
    targetId: string
    reason: ReportReason
    detail?: string
  }): Promise<{ ok: boolean }> {
    return callFunction<{ ok: boolean }>('reportContent', params)
  },

  /** 积分概要：余额 + 累计 + 今日已得 + 称号 + 最近流水 */
  getPoints(): Promise<PointsSummary> {
    return callFunction<PointsSummary>('getPoints')
  },

  /** 兑换商品列表（0 库存自动下架） */
  getPrizes(): Promise<Prize[]> {
    return callFunction<Prize[]>('getPrizes')
  },

  /** 积分兑换（唯一单号幂等，先占库存再扣分） */
  redeemPrize(prizeId: string): Promise<RedeemResult> {
    return callFunction<RedeemResult>('redeemPrize', { prizeId })
  },

  /** 短评列表（服务端门禁：未答 locked） */
  getComments(params: { questionId: string; myOption?: OptionKey | null }): Promise<CommentsData> {
    return callFunction<CommentsData>('getComments', params)
  },

  /** 发短评（40 字内、机审即发、每人每题一条） */
  addComment(params: { questionId: string; option: OptionKey; content: string }): Promise<CommentItem> {
    return callFunction<CommentItem>('addComment', params)
  },

  /** 删短评（仅本人、5 分钟内） */
  deleteComment(commentId: string): Promise<{ ok: boolean }> {
    return callFunction<{ ok: boolean }>('deleteComment', { commentId })
  },

  /** 投稿题目（每天 3 道、机审+人审） */
  submitQuestion(params: {
    title: string
    optionA: string
    optionB: string
    signature?: string
  }): Promise<Submission> {
    return callFunction<Submission>('submitQuestion', params)
  },

  /** 我的投稿列表 */
  getMySubmissions(): Promise<Submission[]> {
    return callFunction<Submission[]>('getMySubmissions')
  }
}
