import { callFunction } from './cloud'
import type {
  AiProfile,
  CommentItem,
  CommentsData,
  FeedbackItem,
  MyHistoryRecord,
  MyReportItem,
  MyStatsData,
  OptionKey,
  PastQuestionData,
  PointsSummary,
  Prize,
  RedeemResult,
  RelookStatus,
  ReportReason,
  RevealData,
  Submission,
  TodayQuestionResult,
  UserProfile,
  VoteResultData,
  VoteStats,
  WeeklyReportData
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

  /** 订阅消息授权上报（云函数记录，次日新题提醒用） */
  subscribeNotify(): Promise<void> {
    return callFunction<void>('subscribeNotify', { action: 'subscribe' })
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
    /** 样本总数（结果页传入，云函数文案分档用） */
    total?: number
    /** 题干与选项内容：云函数生成 AI 侧写用 */
    title?: string
    optionA?: string
    optionB?: string
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

  /** 短评列表（服务端门禁：未答 locked；offset 分页每页 20） */
  getComments(params: {
    questionId: string
    myOption?: OptionKey | null
    offset?: number
  }): Promise<CommentsData> {
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
  },

  /** 我的答题历史（服务端为准，换设备不丢；含回看券状态） */
  getMyHistory(): Promise<{ records: MyHistoryRecord[]; relook: RelookStatus }> {
    return callFunction<{ records: MyHistoryRecord[]; relook: RelookStatus }>('getMyHistory')
  },

  /** 个人统计三件套：连答日历 + 少数派战绩 + 最难选择题 TOP */
  getMyStats(): Promise<MyStatsData> {
    return callFunction<MyStatsData>('getMyStats')
  },

  /** AI 周报（连答满 7 天解锁，未解锁返回 unlocked:false） */
  getWeeklyReport(): Promise<WeeklyReportData> {
    return callFunction<WeeklyReportData>('getWeeklyReport')
  },

  /** 短评点赞（幂等 toggle：已赞则取消），返回最新状态 */
  likeComment(commentId: string): Promise<{ commentId: string; liked: boolean; likes: number }> {
    return callFunction<{ commentId: string; liked: boolean; likes: number }>('likeComment', { commentId })
  },

  /** 往期回看券：随机抽一道往期题（需先兑换 p_relook；每天限抽 1 次） */
  drawPastQuestion(params?: { excludeId?: string }): Promise<PastQuestionData | null> {
    return callFunction<PastQuestionData | null>('drawPastQuestion', params || {})
  },

  /** 我的举报反馈（含后台处理结果说明） */
  getMyReports(): Promise<{ reports: MyReportItem[] }> {
    return callFunction<{ reports: MyReportItem[] }>('getMyReports')
  },

  /** 提交意见反馈（内容 5~300 字，每天最多 3 条） */
  submitFeedback(params: { content: string; contact?: string }): Promise<FeedbackItem> {
    return callFunction<FeedbackItem>('submitFeedback', params)
  },

  /** 我的反馈列表（含开发者回复与采纳奖励积分） */
  getMyFeedback(): Promise<{ feedbacks: FeedbackItem[]; rewardPoints: number }> {
    return callFunction<{ feedbacks: FeedbackItem[]; rewardPoints: number }>('getMyFeedback')
  },

  /** 我的资料（昵称/头像/状态） */
  getProfile(): Promise<UserProfile> {
    return callFunction<UserProfile>('getProfile')
  },

  /** 更新昵称（头像昵称填写能力，≤20 字） */
  updateProfile(nickname: string): Promise<{ nickname: string }> {
    return callFunction<{ nickname: string }>('updateProfile', { nickname })
  },

  /** 上传头像：客户端读 base64 后提交，返回相对 URL（拼 API_BASE 访问） */
  uploadAvatar(params: { data: string; ext: string }): Promise<{ url: string }> {
    return callFunction<{ url: string }>('uploadAvatar', params)
  }
}
