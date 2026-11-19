import type { PointsSummary } from '@/types'
import {
  getPointsLedger,
  getPointsBalance,
  getEarnedToday,
  getOwnedTitles
} from '@/services/storage'

/** mock：getPoints —— 余额 + 累计 + 今日已得 + 称号 + 最近 20 条流水 */
export default function (): PointsSummary {
  const ledger = getPointsLedger()
  return {
    balance: getPointsBalance(),
    totalEarned: ledger
      .filter((e) => e.type === 'earn')
      .reduce((sum, e) => sum + e.amount, 0),
    earnedToday: getEarnedToday(),
    titles: getOwnedTitles(),
    ledger: ledger.slice(0, 20)
  }
}
