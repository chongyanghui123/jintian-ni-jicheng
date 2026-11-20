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
  /** 90 天内将过期的积分（0 则不提示） */
  expiringSoon: number
  /** 已兑换的称号（展示在「我的」） */
  titles: string[]
  /** 限定皮肤（兑换起 30 天有效，过期为 null） */
  skin?: { id: string; name: string; active: boolean; expiresAt: string } | null
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
  /** 点赞数（按热度排序的依据） */
  likes?: number
  /** 我是否已点赞 */
  isLiked?: boolean
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
  /** 还有更多可加载（每页 20 条） */
  hasMore?: boolean
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

/** 服务端答题历史（往期回看，换设备不丢） */
export interface MyHistoryRecord {
  questionId: string
  date: string
  title: string
  optionA: string
  optionB: string
  myOption: OptionKey
  votesA: number
  votesB: number
  total: number
  /** 样本>=30 且我站了占比 <=40% 的少数派 */
  isMinority?: boolean
}

/** getMyHistory 附加状态：回看券持有与今日抽取情况 */
export interface RelookStatus {
  hasTicket: boolean
  drawnToday: boolean
}

/** 最难选择题（|votesA-votesB| 最小，势均力敌的题） */
export interface HardestQuestion {
  questionId: string
  title: string
  optionA: string
  optionB: string
  date: string
  votesA: number
  votesB: number
  total: number
  myOption: OptionKey | null
}

/** 个人页统计三件套：连答日历 + 少数派战绩 + 最难题 TOP */
export interface MyStatsData {
  /** 答过题的全部日期（YYYY-MM-DD，倒序） */
  calendarDates: string[]
  answeredTotal: number
  minorityCount: number
  minorityRate: number
  hardest: HardestQuestion[]
}

/** AI 周报（连答满 7 天解锁，按人+周缓存） */
export interface WeeklyReportData {
  unlocked: boolean
  /** 未解锁时：当前连答天数与还差几天 */
  streak?: number
  needDays?: number
  weekStart?: string
  /** 本周答题天数 */
  days?: number
  minorityCount?: number
  avgDuration?: number
  /** 夜航电台口吻的周报正文 */
  report?: string
}

/** 往期回看券抽到的一道往期题（完整结果） */
export interface PastQuestionData {
  question: Question
  votesA: number
  votesB: number
  total: number
  myOption: OptionKey | null
}

/** 举报原因 */
export type ReportReason = 'low_quality' | 'inappropriate' | 'violation' | 'other'
