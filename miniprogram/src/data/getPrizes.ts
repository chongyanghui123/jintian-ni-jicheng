import type { Prize } from '@/types'
import { DEFAULT_PRIZES } from './points'
import { getPrizeUsedCount, countRedeemedThisMonth } from '@/services/storage'

/** mock：getPrizes —— 商品列表（库存 = 初始库存 - 全局已兑，0 库存自动下架） */
export default function (): Prize[] {
  return DEFAULT_PRIZES.map((p) => ({
    ...p,
    stock: Math.max(0, p.stock - getPrizeUsedCount(p.id)),
    redeemedThisMonth: countRedeemedThisMonth(p.id)
  }))
}
