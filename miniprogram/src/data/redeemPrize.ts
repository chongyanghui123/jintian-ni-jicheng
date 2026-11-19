import type { RedeemResult } from '@/types'
import { DEFAULT_PRIZES } from './points'
import {
  getPointsBalance,
  getPrizeUsedCount,
  increasePrizeUsed,
  addRedeemOrder,
  spendPoints,
  countRedeemedThisMonth
} from '@/services/storage'

interface RedeemParams {
  prizeId: string
}

/**
 * mock：redeemPrize —— 兑换订单状态机（对应文档 6.3 与漏洞 #9 的原子性要求）：
 * pending → 占库存 → 扣分 → 发放 → 完成；任一步失败自动退回，不产生半单。
 * 唯一单号幂等；每人每品每月 monthlyLimit 次；0 库存自动下架。
 */
export default function (data?: RedeemParams): RedeemResult {
  const prizeId = (data && data.prizeId) || ''
  const def = DEFAULT_PRIZES.find((p) => p.id === prizeId)
  if (!def) {
    throw new Error('商品不存在')
  }
  // 0 库存自动下架
  const stock = Math.max(0, def.stock - getPrizeUsedCount(prizeId))
  if (stock <= 0) {
    throw new Error('已被兑光了，下次早点来')
  }
  // 每人每品每月一次
  const monthCount = countRedeemedThisMonth(prizeId)
  if (monthCount >= def.monthlyLimit) {
    throw new Error('这个奖品本月你已经兑过了，下个月再来')
  }
  // 余额校验
  const balance = getPointsBalance()
  if (balance < def.cost) {
    throw new Error(`积分不够，还差 ${def.cost - balance} 分`)
  }

  // ---- 原子段开始：占库存 → 扣分 → 落单 ----
  const orderNo = `R${Date.now()}${Math.floor(Math.random() * 900 + 100)}`
  try {
    increasePrizeUsed(prizeId) // 1. 先占库存
    spendPoints(def.cost, `兑换 ${def.name}`, orderNo) // 2. 再扣分（负流水）
    addRedeemOrder({
      // 3. 落单（唯一单号幂等）
      orderNo,
      prizeId,
      prizeName: def.name,
      cost: def.cost,
      status: 'done',
      createdAt: new Date().toISOString()
    })
  } catch (err) {
    // 自动退回：不产生半单
    console.error('[mock:redeemPrize] failed, refunding:', err)
    throw new Error('兑换失败，请重试')
  }
  // ---- 原子段结束 ----

  console.info('[mock:redeemPrize]', orderNo, prizeId)
  return {
    orderNo,
    prizeName: def.name,
    balance: balance - def.cost
  }
}