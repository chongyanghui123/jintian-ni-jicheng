import dayjs from 'dayjs'

/**
 * 日期口径统一规则（对应产品文档 11.3：时间只由一个函数给出）。
 * 云函数运行环境为 UTC，统一 +8h 换算为北京时间后取日期；
 * 本地（H5 mock）使用同一规则，保证 mock 与云端口径一致。
 */
export function getTodayDate(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

export function getDateOffset(date: string, days: number): string {
  return dayjs(date).add(days, 'day').format('YYYY-MM-DD')
}

/** 展示用中文日期：11月19日 */
export function formatDateCN(date: string): string {
  const d = dayjs(date)
  return `${d.month() + 1}月${d.date()}日`
}

/** 展示用中文日期带星期：11月19日 · 周三 */
export function formatDateCNWithWeek(date: string): string {
  const weeks = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const d = dayjs(date)
  return `${formatDateCN(date)} · ${weeks[d.day()]}`
}

/** 期数：以 2026-11-19 为第 1 期，逐日 +1 */
const ISSUE_EPOCH = '2026-11-19'
export function getIssueNo(date: string): number {
  const diff = dayjs(date).diff(dayjs(ISSUE_EPOCH), 'day')
  return diff + 1
}
