import React, { useCallback, useState } from 'react'
import { View, Text } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import type { PointsSummary, Prize } from '@/types'
import { api } from '@/services/api'
import { POINTS_RULES } from '@/data/points'
import styles from './index.module.scss'

function formatTime(iso: string): string {
  // 展示用：YYYY-MM-DD HH:mm（不做任何本地时区换算逻辑，仅截取）
  return iso.slice(0, 16).replace('T', ' ')
}

const PointsPage: React.FC = () => {
  const [summary, setSummary] = useState<PointsSummary | null>(null)
  const [prizes, setPrizes] = useState<Prize[]>([])
  const [redeemingId, setRedeemingId] = useState<string | null>(null)

  const goBack = () => {
    const pages = Taro.getCurrentPages()
    if (pages.length > 1) {
      Taro.navigateBack({ delta: 1 })
    } else {
      Taro.switchTab({ url: '/pages/mine/index' })
    }
  }

  const refresh = useCallback(() => {
    api
      .getPoints()
      .then(setSummary)
      .catch((err) => console.error('[points] getPoints failed:', err))
    api
      .getPrizes()
      .then(setPrizes)
      .catch((err) => console.error('[points] getPrizes failed:', err))
  }, [])

  useDidShow(() => {
    refresh()
  })

  const onRedeem = (prize: Prize) => {
    if (redeemingId) return
    const balance = summary ? summary.balance : 0
    if (prize.redeemedThisMonth >= prize.monthlyLimit) {
      Taro.showToast({ title: '本月已兑过，下个月再来', icon: 'none' })
      return
    }
    if (prize.stock <= 0) {
      Taro.showToast({ title: '已被兑光了，下次早点来', icon: 'none' })
      return
    }
    if (balance < prize.cost) {
      Taro.showToast({ title: `积分不够，还差 ${prize.cost - balance} 分`, icon: 'none' })
      return
    }
    Taro.showModal({
      title: '确认兑换',
      content: `用 ${prize.cost} 积分兑换「${prize.name}」？积分不退，兑换后立即发放。`,
      confirmText: '兑换',
      cancelText: '再想想',
      success: (res) => {
        if (!res.confirm) return
        setRedeemingId(prize.id)
        api
          .redeemPrize(prize.id)
          .then((result) => {
            Taro.showToast({ title: '兑换成功，已发放', icon: 'success' })
            console.info('[points] redeemed:', result.orderNo)
            refresh()
          })
          .catch((err) => {
            Taro.showToast({ title: err.message || '兑换失败，请重试', icon: 'none' })
          })
          .finally(() => setRedeemingId(null))
      }
    })
  }

  const balance = summary ? summary.balance : 0

  return (
    <View className={styles.page}>
      <View className={styles.backLink} onClick={goBack}>
        <Text>← 返回</Text>
      </View>
      {/* 余额卡 */}
      <View className={styles.balanceCard}>
        <Text className={styles.balanceNum}>{balance}</Text>
        <View className={styles.balanceMeta}>
          <Text className={styles.metaItem}>累计获得 {summary ? summary.totalEarned : 0}</Text>
          <Text className={styles.metaDivider}>·</Text>
          <Text className={styles.metaItem}>今日已得 {summary ? summary.earnedToday : 0}</Text>
        </View>
        {summary && summary.expiringSoon > 0 && (
          <Text className={styles.expiringTip}>
            ⏳ {summary.expiringSoon} 积分将于 90 天内过期，记得使用
          </Text>
        )}
        <Text className={styles.balanceRule}>
          答题 +{POINTS_RULES.ANSWER}，连答 7 天 +{POINTS_RULES.STREAK7}；积分仅在本小程序内使用，不可转让、不可提现，有效期 12 个月。
        </Text>
      </View>

      {/* 兑换区 */}
      <View className={styles.sectionTitle}>积分兑换</View>
      <Text className={styles.sectionHint}>虚拟权益实时发放；每人每品每月 1 次，兑完自动下架，不做限时抢。</Text>
      {prizes.map((p) => {
        const soldOut = p.stock <= 0
        const monthDone = p.redeemedThisMonth >= p.monthlyLimit
        const notEnough = balance < p.cost
        return (
          <View key={p.id} className={styles.prizeCard}>
            <View className={styles.prizeInfo}>
              <Text className={styles.prizeName}>{p.name}</Text>
              <Text className={styles.prizeDesc}>{p.desc}</Text>
              <Text className={styles.prizeStock}>
                {soldOut ? '已被兑光' : `剩余 ${p.stock} 份`} · 每月限 {p.monthlyLimit} 次
              </Text>
            </View>
            <View className={styles.prizeAction}>
              <Text className={styles.prizeCost}>{p.cost} 分</Text>
              <View
                className={`${styles.redeemBtn} ${
                  soldOut || monthDone || notEnough ? styles.redeemBtnDisabled : ''
                }`}
                onClick={() => onRedeem(p)}
              >
                {redeemingId === p.id
                  ? '兑换中…'
                  : soldOut
                    ? '已下架'
                    : monthDone
                      ? '本月已兑'
                      : notEnough
                        ? '积分不足'
                        : '兑换'}
              </View>
            </View>
          </View>
        )
      })}

      {/* 流水区 */}
      <View className={styles.sectionTitle}>积分明细</View>
      <View className={styles.ledgerCard}>
        {summary && summary.ledger.length > 0 ? (
          summary.ledger.map((e) => (
            <View key={e.id} className={styles.ledgerRow}>
              <View className={styles.ledgerInfo}>
                <Text className={styles.ledgerReason}>{e.reason}</Text>
                <Text className={styles.ledgerTime}>{formatTime(e.createdAt)}</Text>
              </View>
              <Text className={e.amount >= 0 ? styles.ledgerPlus : styles.ledgerMinus}>
                {e.amount >= 0 ? `+${e.amount}` : e.amount}
              </Text>
            </View>
          ))
        ) : (
          <View className={styles.ledgerEmpty}>
            <Text>还没有积分记录，答今天这题就有 +{POINTS_RULES.ANSWER}</Text>
          </View>
        )}
      </View>

      <Text className={styles.pageNote}>
        积分由系统发放，流水只增不改；兑换订单生成后不可撤销。对记录有疑问可在「我的」查看说明或联系我们。
      </Text>
    </View>
  )
}

export default PointsPage
