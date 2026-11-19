import React, { useEffect, useState } from 'react'
import { View, Text } from '@tarojs/components'
import type { OptionKey } from '@/types'
import styles from './index.module.scss'

interface RatioBarProps {
  votesA: number
  votesB: number
  total: number
  /** 样本是否达标（>=30 才显示百分比，占比必须真实） */
  showPercent: boolean
}

/**
 * 占比横条：从零涨到目标值；样本不足时不显示百分比，
 * 只显示"样本积累中"，不做假数字。
 */
const RatioBar: React.FC<RatioBarProps> = ({ votesA, votesB, total, showPercent }) => {
  const [grown, setGrown] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setGrown(true), 300)
    return () => clearTimeout(timer)
  }, [votesA, votesB])

  const pctA = total > 0 ? Math.round((votesA / total) * 100) : 50
  const pctB = 100 - pctA

  if (!showPercent) {
    return (
      <View className={styles.wrap}>
        <View className={styles.bar}>
          <View className={styles.pendingFill} />
          <Text className={styles.pendingText}>样本积累中</Text>
        </View>
        <View className={styles.row}>
          <Text className={styles.sideText}>A {votesA} 票</Text>
          <Text className={styles.sideText}>B {votesB} 票</Text>
        </View>
      </View>
    )
  }

  return (
    <View className={styles.wrap}>
      <View className={styles.row}>
        <Text className={styles.pctA}>{pctA}%</Text>
        <Text className={styles.pctB}>{pctB}%</Text>
      </View>
      <View className={styles.bar}>
        <View className={styles.fillA} style={{ width: grown ? `${pctA}%` : '0%' }} />
        <View className={styles.fillB} style={{ width: grown ? `${pctB}%` : '100%' }} />
      </View>
      <View className={styles.row}>
        <Text className={styles.sideText}>共 {total} 人作答</Text>
      </View>
    </View>
  )
}

export default RatioBar
