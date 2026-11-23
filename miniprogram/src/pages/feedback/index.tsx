import React, { useCallback, useState } from 'react'
import { View, Text, Textarea, Input } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import type { FeedbackItem } from '@/types'
import { api } from '@/services/api'
import styles from './index.module.scss'

const DAILY_LIMIT = 3

const FeedbackPage: React.FC = () => {
  const [content, setContent] = useState('')
  const [contact, setContact] = useState('')
  const [busy, setBusy] = useState(false)
  const [list, setList] = useState<FeedbackItem[]>([])
  const [rewardPoints, setRewardPoints] = useState(0)

  const refresh = useCallback(() => {
    api
      .getMyFeedback()
      .then((res) => {
        setList(res.feedbacks || [])
        setRewardPoints(res.rewardPoints || 0)
      })
      .catch((err) => console.error('[feedback] getMyFeedback failed:', err))
  }, [])

  useDidShow(() => {
    refresh()
  })

  const today = new Date().toISOString().slice(0, 10)
  const usedToday = list.filter((f) => f.createdAt.slice(0, 10) === today).length
  const left = Math.max(0, DAILY_LIMIT - usedToday)

  const onSubmit = () => {
    if (busy) return
    const text = content.trim()
    if (text.length < 5) {
      Taro.showToast({ title: '至少写 5 个字，说清楚一点', icon: 'none' })
      return
    }
    if (left <= 0) {
      Taro.showToast({ title: `今天已经反馈 ${DAILY_LIMIT} 条了，明天再来`, icon: 'none' })
      return
    }
    setBusy(true)
    api
      .submitFeedback({ content: text, contact: contact.trim() || undefined })
      .then(() => {
        setContent('')
        setContact('')
        refresh()
        Taro.showToast({ title: '已收到，感谢反馈', icon: 'success' })
      })
      .catch((err) => Taro.showToast({ title: err.message || '提交失败', icon: 'none' }))
      .finally(() => setBusy(false))
  }

  const renderStatus = (f: FeedbackItem) => {
    if (f.status === 'accepted') {
      return (
        <Text className={styles.badgeOk}>
          已采纳{f.reward > 0 ? ` · +${f.reward} 积分` : ''}
        </Text>
      )
    }
    if (f.status === 'rejected') return <Text className={styles.badgeMuted}>未采纳</Text>
    return <Text className={styles.badgePending}>待处理</Text>
  }

  return (
    <View className={styles.page}>
      <View className={styles.hero}>
        <Text className={styles.heroTitle}>意见反馈</Text>
        <Text className={styles.heroSub}>
          用得不顺手、想要的功能、发现的 bug，都可以直接告诉开发者
        </Text>
      </View>

      <View className={styles.formCard}>
        <Text className={styles.label}>反馈内容（5~300 字）</Text>
        <Textarea
          className={styles.textarea}
          value={content}
          maxlength={300}
          placeholderClass='input-ph'
          placeholder='例如：往期回看希望支持按日期筛选，现在只能一天天翻'
          onInput={(e) => setContent(e.detail.value)}
        />
        <Text className={styles.counter}>{content.length}/300</Text>

        <Text className={styles.label}>联系方式（选填，方便开发者回复你）</Text>
        <Input
          className={styles.input}
          value={contact}
          maxlength={50}
          placeholderClass='input-ph'
          placeholder='微信号 / 邮箱，可留空'
          onInput={(e) => setContact(e.detail.value)}
        />

        <View className={styles.submitBtn} onClick={onSubmit}>
          {busy ? '提交中…' : '提交反馈'}
        </View>
        <Text className={styles.formNote}>
          每天最多 {DAILY_LIMIT} 条，今天还剩 {left} 条；意见被采纳会发放积分奖励
          {rewardPoints > 0 ? `（当前 ${rewardPoints} 积分）` : ''}，并在这里收到回复。
        </Text>
      </View>

      <View className={styles.sectionTitle}>我的反馈（{list.length}）</View>
      <View className={styles.listCard}>
        {list.length > 0 ? (
          list.map((f) => (
            <View key={f.id} className={styles.feedItem}>
              <Text className={styles.feedContent}>{f.content}</Text>
              <View className={styles.feedMeta}>
                <Text className={styles.feedTime}>
                  {f.createdAt.slice(0, 10)} {f.createdAt.slice(11, 16)}
                </Text>
                {renderStatus(f)}
              </View>
              {f.reply ? (
                <View className={styles.replyBox}>
                  <Text className={styles.replyLabel}>开发者回复</Text>
                  <Text className={styles.replyText}>{f.reply}</Text>
                </View>
              ) : (
                f.status === 'pending' && (
                  <Text className={styles.replyHint}>已收到，开发者看到后会尽快处理</Text>
                )
              )}
            </View>
          ))
        ) : (
          <Text className={styles.empty}>还没有反馈，写下第一条吧</Text>
        )}
      </View>
    </View>
  )
}

export default FeedbackPage
