/** 选项标识：A 紫罗兰 / B 珊瑚橙 */
export type OptionKey = 'A' | 'B'

/** 题目（每日一题，全站同题） */
export interface Question {
  id: string
  title: string
  optionA: string
  optionB: string
  /** 题目所属日期（YYYY-MM-DD），票按此日期入库，跨零点不串题 */
  date: string
}

/** 投票统计（真实占比，不做修饰） */
export interface VoteStats {
  votesA: number
  votesB: number
  total: number
  /** 我的选择（未答 / 被分享进入时为 null） */
  myOption: OptionKey | null
  /** 本次答题获得的积分（服务端发放） */
  earnedPoints?: number
  /** 获得积分的说明（如"连答 7 天奖励"） */
  earnedReason?: string
}

/** 积分流水（只增不改，服务端发放） */
export interface PointsLedgerEntry {
  id: string
  type: 'earn' | 'redeem'
  /** earn 为正、redeem 为负 */
  amount: number
  reason: string
  /** 幂等键（earn：如 questionId / streak7-周期起点） */
  refId?: string
  /** 兑换唯一单号 */
  orderNo?: string
  createdAt: string
}

export interface PointsSummary {
  balance: number
  totalEarned: number
  earnedToday: number
  /** 已兑换的称号（展示在「我的」） */
  titles: string[]
  /** 最近 20 条流水，倒序 */
  ledger: PointsLedgerEntry[]
}

/** 兑换商品（虚拟品：0 库存自动下架，每人每品每月 monthlyLimit 次） */
export interface Prize {
  id: string
  name: string
  desc: string
  cost: number
  stock: number
  monthlyLimit: number
  /** 我本月已兑次数 */
  redeemedThisMonth: number
}

export interface RedeemResult {
  orderNo: string
  prizeName: string
  balance: number
}

/** 短评：只标 A/B，无昵称头像（对应文档 4.3） */
export interface CommentItem {
  id: string
  questionId: string
  option: OptionKey
  /** ≤40 字 */
  content: string
  /** 本人短评，带"你"角标 */
  isMine: boolean
  /** 软配额置顶：对立面短评标注"对面的理由" */
  isOppositeTop?: boolean
  /** 累计 3 次举报自动隐藏 */
  hidden?: boolean
  createdAt: string
}

export interface CommentsData {
  /** 服务端门禁：未答该题不可读 */
  locked: boolean
  comments: CommentItem[]
  /** 我在本题的短评（每人每题一条，5 分钟内可删） */
  mine: CommentItem | null
  total: number
}

/** 用户投稿（对应文档 4.2：每天 3 道，机审+人审，通过后进次日起题池） */
export interface Submission {
  id: string
  title: string
  optionA: string
  optionB: string
  /** 2-8 字，空显示"网友投稿" */
  signature: string
  status: 'pending' | 'approved' | 'rejected'
  /** 通过后的上墙时间（00:00 冻结：当日投稿一律次日起） */
  showDate?: string
  /** 驳回原因（不得写"不符合规范"） */
  rejectReason?: string
  createdAt: string
}

/** AI 侧写：固定标签池 + 30-60 字 + 免责 */
export interface AiProfile {
  tag: string
  text: string
  disclaimer: string
}

/** 昨日揭晓数据 */
export interface RevealData {
  date: string
  question: Question | null
  votesA: number
  votesB: number
  total: number
  myOption: OptionKey | null
  /** 离线降级：用本地最后一次数据，文案标"截至你离开时" */
  offline?: boolean
}

/** 本地答题记录（往期回看 + 统计的数据源） */
export interface AnswerRecord {
  questionId: string
  date: string
  title: string
  optionA: string
  optionB: string
  myOption: OptionKey
  /** 决策时长（秒，0-60） */
  duration: number
  votesA: number
  votesB: number
  total: number
  answeredAt: number
}

/** getTodayQuestion 云函数返回 */
export interface TodayQuestionResult {
  serverDate: string
  question: Question | null
  answered: boolean
  myOption: OptionKey | null
  myDuration: number
}

/** getVoteResult 云函数返回 */
export interface VoteResultData extends VoteStats {
  question: Question | null
  /** 题目是否已过期（非今日） */
  isExpired: boolean
}

/** 举报原因 */
export type ReportReason = 'low_quality' | 'inappropriate' | 'violation' | 'other'
