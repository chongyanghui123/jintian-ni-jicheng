import React, { useState } from 'react'
import { View, Text } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import type { MyStats } from '@/services/storage'
import type { PointsSummary } from '@/types'
import { getMyStats, hasAnsweredToday } from '@/services/storage'
import { POINTS_RULES } from '@/data/points'
import { api } from '@/services/api'
import styles from './index.module.scss'

const MinePage: React.FC = () => {
  const [stats, setStats] = useState<MyStats>({
    totalDays: 0,
    minorityCount: 0,
    minorityRate: 0,
    avgDuration: 0,
    streakDays: 0
  })
  const [answeredToday, setAnsweredToday] = useState(false)
  const [points, setPoints] = useState<PointsSummary | null>(null)

  useDidShow(() => {
    setStats(getMyStats())
    setAnsweredToday(hasAnsweredToday())
    api
      .getPoints()
      .then(setPoints)
      .catch((err) => console.error('[mine] getPoints failed:', err))
  })

  const goToday = () => Taro.switchTab({ url: '/pages/today/index' })
  const goPoints = () => Taro.navigateTo({ url: '/pages/points/index' })
  const goSubmit = () => Taro.navigateTo({ url: '/pages/submit/index' })
  const goAbout = () => Taro.navigateTo({ url: '/pages/about/index' })

  // 连答进度：本周期已连 n 天，满 7 领 +10
  const cycleDays = stats.streakDays % 7 === 0 && stats.streakDays > 0 ? 7 : stats.streakDays % 7

  return (
    <View className={styles.page}>
      <View className={styles.hero}>
        <Text className={styles.heroTitle}>你的答题档案</Text>
        <Text className={styles.heroSub}>数据只来自你自己，不和别人比</Text>
      </View>

      {/* 积分卡 */}
      <View className={styles.pointsCard} onClick={goPoints}>
        <View className={styles.pointsLeft}>
          <Text className={styles.pointsBalance}>{points ? points.balance : 0}</Text>
          <Text className={styles.pointsLabel}>我的积分 · 今日已得 {points ? points.earnedToday : 0}</Text>
          {points && points.titles.length > 0 && (
            <View className={styles.titlesRow}>
              {points.titles.map((t) => (
                <Text key={t} className={styles.titleChip}>
                  {t}
                </Text>
              ))}
            </View>
          )}
        </View>
        <View className={styles.pointsBtn}>去兑换</View>
      </View>

      {/* 任务进度卡 */}
      <View className={styles.statsCard}>
        <View className={styles.taskRow}>
          <View className={styles.taskInfo}>
            <Text className={styles.taskName}>每日答题</Text>
            <Text className={styles.taskDesc}>答完今天这题 +{POINTS_RULES.ANSWER} 分</Text>
          </View>
          {answeredToday ? (
            <Text className={styles.taskDone}>已完成 ✓</Text>
          ) : (
            <View className={styles.taskBtn} onClick={goToday}>
              去答题
            </View>
          )}
        </View>
        <View className={styles.taskDivider} />
        <View className={styles.taskRow}>
          <View className={styles.taskInfo}>
            <Text className={styles.taskName}>连答 {POINTS_RULES.STREAK7} 天</Text>
            <Text className={styles.taskDesc}>进度 {cycleDays}/7，满 7 天 +{POINTS_RULES.STREAK7} 分</Text>
          </View>
          {cycleDays >= 7 && answeredToday ? (
            <Text className={styles.taskDone}>已领取 ✓</Text>
          ) : (
            <Text className={styles.taskProgress}>{cycleDays}/7</Text>
          )}
        </View>
      </View>

      <View className={styles.statsCard}>
        <View className={styles.statsGrid}>
          <View className={styles.statItem}>
            <Text className={styles.statValue}>{stats.totalDays}</Text>
            <Text className={styles.statLabel}>累计答题（天）</Text>
          </View>
          <View className={styles.statItem}>
            <Text className={`${styles.statValue} ${styles.statValueAccent}`}>
              {stats.streakDays}
            </Text>
            <Text className={styles.statLabel}>连续答题（天）</Text>
          </View>
          <View className={styles.statItem}>
            <Text className={`${styles.statValue} ${styles.statValueAccent}`}>
              {stats.minorityRate}%
            </Text>
            <Text className={styles.statLabel}>站少数派的占比</Text>
          </View>
          <View className={styles.statItem}>
            <Text className={styles.statValue}>{stats.avgDuration}s</Text>
            <Text className={styles.statLabel}>平均决策时长</Text>
          </View>
        </View>
      </View>

      <View className={styles.entryCard} onClick={goSubmit}>
        <Text className={styles.entryText}>投稿题目</Text>
        <Text className={styles.entryArrow}>›</Text>
      </View>

      <View className={styles.entryCard} onClick={goAbout}>
        <Text className={styles.entryText}>关于与隐私</Text>
        <Text className={styles.entryArrow}>›</Text>
      </View>

      <View className={styles.noticeCard}>
        <Text className={styles.noticeTitle}>内容与未成年人提示</Text>
        <Text className={styles.noticeText}>
          题目内容由社区与运营提供，可能不适合所有人；如看到不适内容，可在结果页举报。本产品不做任何诱导性设计，没有连击挽留弹窗，也没有限时抢兑。
        </Text>
      </View>

      <View className={styles.noticeCard}>
        <Text className={styles.noticeTitle}>免责说明</Text>
        <Text className={styles.noticeText}>
          占比数据全部来自真实投票，不做修饰；AI 侧写由算法生成，仅供娱乐，不构成任何心理判断或建议。你的答题记录仅保存在本机，不向其他用户展示。
        </Text>
      </View>

      <View className={styles.footer}>
        <Text className={styles.version}>今天你几成 · MVP V0.2.0</Text>
      </View>
    </View>
  )
}

export default MinePage
