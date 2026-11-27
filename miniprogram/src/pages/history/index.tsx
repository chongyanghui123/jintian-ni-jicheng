import React, { useCallback, useState } from 'react'
import { View, Text } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import type { HardestQuestion, MyHistoryRecord, PastQuestionData, RelookStatus } from '@/types'
import { api } from '@/services/api'
import { getAnswerRecords, optionRatio } from '@/services/storage'
import { formatDateCNWithWeek } from '@/utils/date'
import styles from './index.module.scss'

/** 往期回看：服务端答题记录为准（换设备不丢），接口失败降级本地缓存；
 *  顶部「往期回看」入口消耗往期回看券（每天限抽 1 次）；
 *  「最难的选择」：全站投票势均力敌的往期题 TOP 5 */
const HistoryPage: React.FC = () => {
  const [loading, setLoading] = useState(true)
  const [records, setRecords] = useState<MyHistoryRecord[]>([])
  const [past, setPast] = useState<PastQuestionData | null>(null)
  const [pastLoading, setPastLoading] = useState(false)
  const [pastErr, setPastErr] = useState('') // 抽卡失败原因：无券 / 今日已抽
  const [relook, setRelook] = useState<RelookStatus | null>(null)
  const [hardest, setHardest] = useState<HardestQuestion[]>([])

  useDidShow(() => {
    setLoading(true)
    api
      .getMyHistory()
      .then((res) => {
        setRecords(res.records)
        setRelook(res.relook)
      })
      .catch(() => {
        // 离线/接口异常：降级本地记录（字段兼容，duration/answeredAt 不展示）
        setRecords(getAnswerRecords() as unknown as MyHistoryRecord[])
      })
      .finally(() => setLoading(false))
    api
      .getMyStats()
      .then((s) => setHardest(s.hardest))
      .catch(() => {})
  })

  const openRecordId = (questionId: string) => {
    Taro.navigateTo({ url: `/pages/result/index?questionId=${questionId}` })
  }

  /** 用回看券抽一道往期题；没券/今日已抽时展示对应引导 */
  const drawPast = useCallback((excludeId?: string) => {
    if (pastLoading) return
    setPastLoading(true)
    setPastErr('')
    api
      .drawPastQuestion({ excludeId })
      .then((res) => {
        if (!res) {
          // 没有可抽的往期题：不置「今日已抽」，否则会误显示“明天再来”
          setPast(null)
          setPastErr('暂时没有可回看的往期题')
          return
        }
        setPast(res)
        setRelook((prev) => ({ hasTicket: prev?.hasTicket ?? true, drawnToday: true }))
      })
      .catch((err) => {
        setPast(null)
        setPastErr(err.message || '抽取失败')
      })
      .finally(() => setPastLoading(false))
  }, [pastLoading])

  const goPoints = () => {
    Taro.navigateTo({ url: '/pages/points/index' })
  }

  // 回看券入口的三种状态：无券引导兑换 / 今日已抽 / 可抽
  const noTicket = relook ? !relook.hasTicket : false
  const drawnToday = relook ? relook.drawnToday : false
  const isBlocked = noTicket || pastErr.includes('兑换')
  const isDrawn = pastErr.includes('明天') || (!past && !pastErr && drawnToday)

  if (!loading && records.length === 0) {
    return (
      <View className={styles.page}>
        <View className={styles.empty}>
          <Text className={styles.emptyEmoji}>🗓️</Text>
          <Text className={styles.emptyText}>还没有答题记录</Text>
          <View className={styles.emptyBtn} onClick={() => Taro.switchTab({ url: '/pages/today/index' })}>
            去答今天这题
          </View>
        </View>
      </View>
    )
  }

  return (
    <View className={styles.page}>
      {/* 往期回看券解锁的题 */}
      {past && (
        <View className={styles.card} onClick={() => openRecordId(past.question.id)}>
          <View className={styles.dateRow}>
            <Text className={styles.date}>{formatDateCNWithWeek(past.question.date)}</Text>
            <Text className={styles.lookbackTag}>回看券解锁</Text>
          </View>
          <Text className={styles.title}>{past.question.title}</Text>
          <View className={styles.ratioRow}>
            <Text className={styles.ratioText}>
              {past.total >= 30
                ? `${optionRatio(past.votesA, past.votesB, 'A')}% 选了「${past.question.optionA}」`
                : `样本积累中 · ${past.total} 人作答`}
            </Text>
            {past.total >= 30 && (
              <View className={styles.ratioBar}>
                <View className={styles.ratioFill} style={{ width: `${optionRatio(past.votesA, past.votesB, 'A')}%` }} />
              </View>
            )}
          </View>
          <View className={styles.lookbackBtn} onClick={(e) => { e.stopPropagation(); drawPast(past.question.id) }}>
            {pastLoading ? '翻一道…' : '换一道 ↻'}
          </View>
        </View>
      )}
      {/* 回看券入口三态：无券 / 今日已抽 / 可抽 */}
      {!past && !pastLoading && isBlocked && (
        <View className={styles.card} onClick={goPoints}>
          <Text className={styles.lookbackTitle}>🎟️ 往期回看</Text>
          <Text className={styles.lookbackHint}>需要「往期回看券」，去积分页兑换一张 →</Text>
        </View>
      )}
      {!past && !pastLoading && !isBlocked && isDrawn && (
        <View className={styles.card}>
          <Text className={styles.lookbackTitle}>🎟️ 往期回看</Text>
          <Text className={styles.lookbackHint}>今天已经回看过一道题了，明天再来</Text>
        </View>
      )}
      {!past && !pastLoading && !isBlocked && !isDrawn && (
        <View className={styles.card} onClick={() => drawPast()}>
          <Text className={styles.lookbackTitle}>🎟️ 往期回看</Text>
          <Text className={styles.lookbackHint}>用回看券随机解锁一道往期题 · 每天限一次</Text>
        </View>
      )}
      {/* 抽卡失败：把错误原因显示出来，点击可重试（之前错误被吞掉，用户无反馈） */}
      {!past && !pastLoading && pastErr && !isBlocked && !isDrawn && (
        <View className={styles.card} onClick={() => drawPast()}>
          <Text className={styles.lookbackTitle}>🎟️ 往期回看</Text>
          <Text className={styles.lookbackHint}>{pastErr}，点这里重试</Text>
        </View>
      )}

      {/* 最难的选择：全站投票势均力敌的往期题 TOP 5 */}
      {hardest.length > 0 && (
        <View className={styles.sectionTitle}>
          <Text className={styles.sectionText}>⚖️ 最难的选择 · 势均力敌 TOP {hardest.length}</Text>
        </View>
      )}
      {hardest.map((h) => {
        const pctA = optionRatio(h.votesA, h.votesB, 'A')
        return (
          <View key={h.questionId} className={styles.card} onClick={() => openRecordId(h.questionId)}>
            <View className={styles.dateRow}>
              <Text className={styles.date}>{formatDateCNWithWeek(h.date)}</Text>
              <Text className={styles.hardestTag}>{pctA}% vs {100 - pctA}%</Text>
            </View>
            <Text className={styles.title}>{h.title}</Text>
            <View className={styles.ratioRow}>
              <Text className={styles.ratioText}>{h.total} 人作答</Text>
              <View className={styles.ratioBar}>
                <View className={styles.ratioFill} style={{ width: `${pctA}%` }} />
              </View>
              {h.myOption && (
                <Text className={styles.myChoiceBadge}>我选 {h.myOption}</Text>
              )}
            </View>
          </View>
        )
      })}

      {records.map((record) => {
        const pctA = optionRatio(record.votesA, record.votesB, 'A')
        const sampleOk = record.total >= 30
        const myChoice = record.myOption === 'A' ? record.optionA : record.optionB
        const ratioText = sampleOk
          ? `${pctA}% 选了「${record.optionA}」`
          : `样本积累中 · ${record.total} 人作答`
        return (
          <View key={record.questionId} className={styles.card} onClick={() => openRecordId(record.questionId)}>
            <View className={styles.dateRow}>
              <Text className={styles.date}>{formatDateCNWithWeek(record.date)}</Text>
              <Text
                className={`${styles.myChoice} ${
                  record.myOption === 'A' ? styles.choiceA : styles.choiceB
                }`}
              >
                我选了 {myChoice}
              </Text>
            </View>
            <Text className={styles.title}>{record.title}</Text>
            <View className={styles.ratioRow}>
              <Text className={styles.ratioText}>{ratioText}</Text>
              {sampleOk && (
                <View className={styles.ratioBar}>
                  <View className={styles.ratioFill} style={{ width: `${pctA}%` }} />
                </View>
              )}
            </View>
          </View>
        )
      })}
    </View>
  )
}

export default HistoryPage
