import React, { useState } from 'react'
import { View, Text } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import type { AnswerRecord } from '@/types'
import { getAnswerRecords, optionRatio } from '@/services/storage'
import { formatDateCNWithWeek } from '@/utils/date'
import styles from './index.module.scss'

/** 往期回看：本地答题记录倒序，只读不给答题入口（过期题不能再答） */
const HistoryPage: React.FC = () => {
  const [records, setRecords] = useState<AnswerRecord[]>([])

  useDidShow(() => {
    setRecords(getAnswerRecords())
  })

  const openRecord = (record: AnswerRecord) => {
    Taro.navigateTo({ url: `/pages/result/index?questionId=${record.questionId}` })
  }

  if (records.length === 0) {
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
      {records.map((record) => {
          const pctA = optionRatio(record.votesA, record.votesB, 'A')
          const sampleOk = record.total >= 30
          const myChoice = record.myOption === 'A' ? record.optionA : record.optionB
          const ratioText = sampleOk
            ? `${pctA}% 选了「${record.optionA}」`
            : `样本积累中 · ${record.total} 人作答`
          return (
            <View key={record.questionId} className={styles.card} onClick={() => openRecord(record)}>
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
