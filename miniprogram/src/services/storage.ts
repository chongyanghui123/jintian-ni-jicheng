import Taro from '@tarojs/taro'
import type { AnswerRecord, OptionKey, PointsLedgerEntry, CommentItem, Submission } from '@/types'
import { getTodayDate, getDateOffset } from '@/utils/date'

const KEY_RECORDS = 'jc_answer_records' // 答题记录（最近 90 条）
const KEY_REVEAL_READ = 'jc_reveal_read' // 昨日揭晓已读日期
const KEY_MINOR_NOTICE = 'jc_minor_notice' // 未成年提示是否已展示
const KEY_POINTS_LEDGER = 'jc_points_ledger' // 积分流水（只增不改）
const KEY_PRIZE_USED = 'jc_prize_used' // 各奖品已兑数量 {prizeId: n}
const KEY_REDEEM_ORDERS = 'jc_redeem_orders' // 兑换订单
const KEY_COMMENTS = 'jc_comments' // 短评（本地 mock 数据层）
const KEY_COMMENT_REPORTS = 'jc_comment_reports' // 短评举报计数 {commentId: n}
const KEY_SUBMISSIONS = 'jc_submissions' // 用户投稿（本地 mock 数据层）
const MAX_RECORDS = 90

function readRecords(): AnswerRecord[] {
  try {
    const list = Taro.getStorageSync(KEY_RECORDS)
    return Array.isArray(list) ? list : []
  } catch (err) {
    console.error('[Storage] readRecords failed:', err)
    return []
  }
}

export function getAnswerRecords(): AnswerRecord[] {
  return readRecords().slice().sort((a, b) => (a.date < b.date ? 1 : -1))
}

export function getRecordById(questionId: string): AnswerRecord | null {
  return readRecords().find((r) => r.questionId === questionId) || null
}

export function getRecordByDate(date: string): AnswerRecord | null {
  return readRecords().find((r) => r.date === date) || null
}

export function saveAnswerRecord(record: AnswerRecord): void {
  try {
    const list = readRecords().filter((r) => r.questionId !== record.questionId)
    list.push(record)
    list.sort((a, b) => (a.date < b.date ? 1 : -1))
    Taro.setStorageSync(KEY_RECORDS, list.slice(0, MAX_RECORDS))
    console.info('[Storage] saveAnswerRecord:', record.questionId, record.myOption)
  } catch (err) {
    console.error('[Storage] saveAnswerRecord failed:', err)
  }
}

/** 昨日揭晓是否已读（按"今天"记） */
export function isRevealRead(today: string): boolean {
  return Taro.getStorageSync(KEY_REVEAL_READ) === today
}

export function markRevealRead(today: string): void {
  try {
    Taro.setStorageSync(KEY_REVEAL_READ, today)
  } catch (err) {
    console.error('[Storage] markRevealRead failed:', err)
  }
}

export function isMinorNoticeShown(): boolean {
  return Taro.getStorageSync(KEY_MINOR_NOTICE) === '1'
}

export function markMinorNoticeShown(): void {
  try {
    Taro.setStorageSync(KEY_MINOR_NOTICE, '1')
  } catch (err) {
    console.error('[Storage] markMinorNoticeShown failed:', err)
  }
}

/** 我的统计：答题天数 / 少数派次数与占比 / 平均决策时长 / 连续答题天数 */
export interface MyStats {
  totalDays: number
  minorityCount: number
  minorityRate: number // 0-100
  avgDuration: number // 秒
  streakDays: number
}

export function getMyStats(): MyStats {
  const records = readRecords()
  if (records.length === 0) {
    return { totalDays: 0, minorityCount: 0, minorityRate: 0, avgDuration: 0, streakDays: 0 }
  }
  const minority = records.filter((r) => {
    const myRatio = r.total > 0 ? (r.myOption === 'A' ? r.votesA : r.votesB) / r.total : 0
    return r.total >= 30 && myRatio <= 0.4 // 样本达标才算数
  }).length
  const avgDuration =
    records.reduce((sum, r) => sum + (r.duration || 0), 0) / Math.max(1, records.length)

  // 连续答题天数：今天没答不断签，从昨天开始数
  const dates = new Set(records.map((r) => r.date))
  let cursor = getTodayDate()
  if (!dates.has(cursor)) cursor = getDateOffset(cursor, -1)
  let streak = 0
  while (dates.has(cursor)) {
    streak++
    cursor = getDateOffset(cursor, -1)
  }

  return {
    totalDays: records.length,
    minorityCount: minority,
    minorityRate: Math.round((minority / records.length) * 100),
    avgDuration: Math.round(avgDuration * 10) / 10,
    streakDays: streak
  }
}

/** 今天是否已答题（任务卡判断依据） */
export function hasAnsweredToday(): boolean {
  try {
    const records: AnswerRecord[] = Taro.getStorageSync(KEY_RECORDS) || []
    return Array.isArray(records) && records.some((r) => r.date === getTodayDate())
  } catch (err) {
    console.error('[Storage] hasAnsweredToday failed:', err)
    return false
  }
}

/** 某选项占比（百分比整数） */
export function optionRatio(votesA: number, votesB: number, option: OptionKey): number {
  const total = votesA + votesB
  if (total <= 0) return 0
  const votes = option === 'A' ? votesA : votesB
  return Math.round((votes / total) * 100)
}

// ---------- 积分账本（mock 数据层共用；云上由 points_ledger 集合承担） ----------

function readLedger(): PointsLedgerEntry[] {
  try {
    const list = Taro.getStorageSync(KEY_POINTS_LEDGER)
    return Array.isArray(list) ? list : []
  } catch (err) {
    console.error('[Storage] readLedger failed:', err)
    return []
  }
}

export function getPointsLedger(): PointsLedgerEntry[] {
  return readLedger().slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

/** 发放积分（幂等：同 refId 只发一次；流水只增不改） */
export function earnPoints(amount: number, reason: string, refId: string): boolean {
  try {
    const list = readLedger()
    if (list.some((e) => e.type === 'earn' && e.refId === refId)) {
      return false // 已发放过
    }
    list.push({
      id: `e${Date.now()}${Math.floor(Math.random() * 1000)}`,
      type: 'earn',
      amount,
      reason,
      refId,
      createdAt: new Date().toISOString()
    })
    Taro.setStorageSync(KEY_POINTS_LEDGER, list)
    console.info('[Storage] earnPoints:', amount, reason, refId)
    return true
  } catch (err) {
    console.error('[Storage] earnPoints failed:', err)
    return false
  }
}

export function getPointsBalance(): number {
  return readLedger().reduce((sum, e) => sum + e.amount, 0)
}

export function getEarnedToday(): number {
  const today = getTodayDate()
  return readLedger()
    .filter((e) => e.type === 'earn' && e.createdAt.slice(0, 10) === today)
    .reduce((sum, e) => sum + e.amount, 0)
}

// ---------- 兑换订单（唯一单号，流水只增） ----------

export interface RedeemOrder {
  orderNo: string
  prizeId: string
  prizeName: string
  cost: number
  status: 'done' | 'refunded'
  createdAt: string
}

function readOrders(): RedeemOrder[] {
  try {
    const list = Taro.getStorageSync(KEY_REDEEM_ORDERS)
    return Array.isArray(list) ? list : []
  } catch (err) {
    console.error('[Storage] readOrders failed:', err)
    return []
  }
}

export function getRedeemOrders(): RedeemOrder[] {
  return readOrders().slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export function addRedeemOrder(order: RedeemOrder): void {
  try {
    const list = readOrders()
    if (list.some((o) => o.orderNo === order.orderNo)) {
      return // 唯一单号幂等
    }
    list.push(order)
    Taro.setStorageSync(KEY_REDEEM_ORDERS, list)
  } catch (err) {
    console.error('[Storage] addRedeemOrder failed:', err)
  }
}

/** 本月已兑某品次数（每人每品每月一次的判断依据） */
export function countRedeemedThisMonth(prizeId: string): number {
  const month = getTodayDate().slice(0, 7)
  return readOrders().filter(
    (o) => o.prizeId === prizeId && o.status === 'done' && o.createdAt.slice(0, 7) === month
  ).length
}

/** 已兑换称号（status done 的称号订单） */
export function getOwnedTitles(): string[] {
  return readOrders()
    .filter((o) => o.prizeId === 'p_title' && o.status === 'done')
    .map((o) => o.prizeName)
}

export function getPrizeUsedCount(prizeId: string): number {
  try {
    const used = Taro.getStorageSync(KEY_PRIZE_USED) || {}
    return used[prizeId] || 0
  } catch (err) {
    console.error('[Storage] getPrizeUsedCount failed:', err)
    return 0
  }
}

export function increasePrizeUsed(prizeId: string): void {
  try {
    const used = Taro.getStorageSync(KEY_PRIZE_USED) || {}
    used[prizeId] = (used[prizeId] || 0) + 1
    Taro.setStorageSync(KEY_PRIZE_USED, used)
  } catch (err) {
    console.error('[Storage] increasePrizeUsed failed:', err)
  }
}

/** 扣积分（兑换时）：写负流水 */
export function spendPoints(amount: number, reason: string, orderNo: string): void {
  try {
    const list = readLedger()
    list.push({
      id: `r${Date.now()}${Math.floor(Math.random() * 1000)}`,
      type: 'redeem',
      amount: -amount,
      reason,
      orderNo,
      createdAt: new Date().toISOString()
    })
    Taro.setStorageSync(KEY_POINTS_LEDGER, list)
    console.info('[Storage] spendPoints:', amount, reason, orderNo)
  } catch (err) {
    console.error('[Storage] spendPoints failed:', err)
  }
}

// ---------- 短评（mock 数据层；云上由 comments 集合承担） ----------

function readComments(): CommentItem[] {
  try {
    const list = Taro.getStorageSync(KEY_COMMENTS)
    return Array.isArray(list) ? list : []
  } catch (err) {
    console.error('[Storage] readComments failed:', err)
    return []
  }
}

export function getCommentsByQuestion(questionId: string): CommentItem[] {
  return readComments()
    .filter((c) => c.questionId === questionId && !c.hidden)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
}

export function addLocalComment(comment: CommentItem): void {
  try {
    const list = readComments()
    // 每人每题一条
    const mine = list.find((c) => c.questionId === comment.questionId && c.isMine)
    if (mine) {
      throw new Error('已经写过这道题的短评')
    }
    list.push(comment)
    Taro.setStorageSync(KEY_COMMENTS, list)
  } catch (err) {
    console.error('[Storage] addLocalComment failed:', err)
    throw err
  }
}

export function deleteLocalComment(commentId: string): boolean {
  try {
    const list = readComments()
    const target = list.find((c) => c.id === commentId && c.isMine)
    if (!target) return false
    // 5 分钟内可删（对应 V1.7 修订：不可改但开 5 分钟撤回窗口）
    if (Date.now() - new Date(target.createdAt).getTime() > 5 * 60 * 1000) {
      return false
    }
    const next = list.filter((c) => c.id !== commentId)
    Taro.setStorageSync(KEY_COMMENTS, next)
    return true
  } catch (err) {
    console.error('[Storage] deleteLocalComment failed:', err)
    return false
  }
}

export function bumpCommentReport(commentId: string): number {
  try {
    const map = Taro.getStorageSync(KEY_COMMENT_REPORTS) || {}
    map[commentId] = (map[commentId] || 0) + 1
    Taro.setStorageSync(KEY_COMMENT_REPORTS, map)
    // 累计 3 次举报自动隐藏（对应文档 8.1）
    if (map[commentId] >= 3) {
      const list = readComments().map((c) =>
        c.id === commentId ? { ...c, hidden: true } : c
      )
      Taro.setStorageSync(KEY_COMMENTS, list)
      console.info('[Storage] comment auto-hidden after 3 reports:', commentId)
    }
    return map[commentId]
  } catch (err) {
    console.error('[Storage] bumpCommentReport failed:', err)
    return 0
  }
}

// ---------- 投稿（mock 数据层；云上由 submissions 集合承担） ----------

export function getSubmissions(): Submission[] {
  try {
    const list = Taro.getStorageSync(KEY_SUBMISSIONS)
    return Array.isArray(list)
      ? list.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      : []
  } catch (err) {
    console.error('[Storage] getSubmissions failed:', err)
    return []
  }
}

export function addSubmission(sub: Submission): void {
  try {
    const list = getSubmissions()
    list.unshift(sub)
    Taro.setStorageSync(KEY_SUBMISSIONS, list.slice(0, 100))
  } catch (err) {
    console.error('[Storage] addSubmission failed:', err)
  }
}

export function countSubmissionsToday(): number {
  const today = getTodayDate()
  return getSubmissions().filter((s) => s.createdAt.slice(0, 10) === today).length
}
