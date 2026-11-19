import React, { useEffect, useRef, useState } from 'react'
import { View, Text } from '@tarojs/components'
import Taro, { useDidShow, usePageScroll, useShareAppMessage } from '@tarojs/taro'
import type { OptionKey, Question, RevealData } from '@/types'
import { api } from '@/services/api'
import {
  isMinorNoticeShown,
  isRevealRead,
  markMinorNoticeShown,
  markRevealRead,
  saveAnswerRecord
} from '@/services/storage'
import { formatDateCNWithWeek, getIssueNo, getTodayDate } from '@/utils/date'
import RevealBanner from '@/components/RevealBanner'
import OptionButton from '@/components/OptionButton'
import styles from './index.module.scss'

const TodayPage: React.FC = () => {
  const [loading, setLoading] = useState(true)
  const [question, setQuestion] = useState<Question | null>(null)
  const [serverDate, setServerDate] = useState<string>('')
  const [answered, setAnswered] = useState(false)
  const [myOption, setMyOption] = useState<OptionKey | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [reveal, setReveal] = useState<RevealData | null>(null)
  const [revealVisible, setRevealVisible] = useState(false)
  const [revealCollapsed, setRevealCollapsed] = useState(false)

  /** 题目曝光时间戳：决策时长的计时起点 */
  const shownAtRef = useRef(0)

  // 分享兜底模板（样本不足场景）
  useShareAppMessage(() => ({
    title: '今天这题有点难选，你来',
    path: '/pages/today/index'
  }))

  const loadData = async () => {
    try {
      const res = await api.getTodayQuestion()
      setServerDate(res.serverDate)
      setQuestion(res.question)
      setAnswered(res.answered)
      setMyOption(res.myOption)
      if (!res.answered) {
        // 未答才重新计时，已答不需要
        shownAtRef.current = Date.now()
      }
      // 昨日揭晓：只在今天首次进入且未读过时展示
      if (!isRevealRead(getTodayDate())) {
        try {
          const rv = await api.getYesterdayResult()
          if (rv && rv.question) {
            setReveal(rv)
            setRevealVisible(true)
          }
        } catch (err) {
          console.error('[Today] getYesterdayResult failed:', err)
        }
      }
    } catch (err) {
      console.error('[Today] getTodayQuestion failed:', err)
      Taro.showToast({ title: '加载失败，下拉重试', icon: 'none' })
    } finally {
      setLoading(false)
    }
  }

  useDidShow(() => {
    loadData()
  })

  // 未成年内容提示：只弹一次
  useEffect(() => {
    if (!isMinorNoticeShown()) {
      markMinorNoticeShown()
      Taro.showModal({
        title: '内容提示',
        content:
          '题目内容由社区提供，可能不适合所有人。如看到不适内容，可在结果页举报。带你看看今天大家怎么选。',
        showCancel: false,
        confirmText: '知道了'
      })
    }
  }, [])

  // 页面滚动自动收起揭晓条
  usePageScroll((res) => {
    const collapsed = res.scrollTop > 60
    if (collapsed !== revealCollapsed) {
      setRevealCollapsed(collapsed)
    }
  })

  /** 点击选项即提交，不可反悔；时长 0-60s 封顶 */
  const handleChoose = async (option: OptionKey) => {
    if (!question || submitting || answered) return
    setSubmitting(true)
    const duration = Math.max(
      1,
      Math.min(60, Math.round((Date.now() - shownAtRef.current) / 1000))
    )
    Taro.showLoading({ title: '提交中', mask: true })
    try {
      const stats = await api.submitVote({ questionId: question.id, option, duration })
      saveAnswerRecord({
        questionId: question.id,
        date: serverDate || question.date,
        title: question.title,
        optionA: question.optionA,
        optionB: question.optionB,
        myOption: option,
        duration,
        votesA: stats.votesA,
        votesB: stats.votesB,
        total: stats.total,
        answeredAt: Date.now()
      })
      setAnswered(true)
      setMyOption(option)
      Taro.hideLoading()
      if (stats.earnedPoints && stats.earnedPoints > 0) {
        // 积分由服务端发放，仅作告知
        Taro.showToast({
          title: `积分 +${stats.earnedPoints}${stats.earnedReason ? `（${stats.earnedReason}）` : ''}`,
          icon: 'none',
          duration: 2000
        })
      }
      Taro.navigateTo({ url: `/pages/result/index?questionId=${question.id}` })
    } catch (err) {
      console.error('[Today] submitVote failed:', err)
      Taro.hideLoading()
      Taro.showToast({ title: (err as Error).message || '提交失败', icon: 'none' })
    } finally {
      setSubmitting(false)
    }
  }

  const handleCloseReveal = () => {
    setRevealVisible(false)
    markRevealRead(getTodayDate())
  }

  const handleOpenReveal = () => {
    if (!reveal || !reveal.question) return
    markRevealRead(getTodayDate())
    Taro.navigateTo({
      url: `/pages/result/index?questionId=${reveal.question.id}&from=reveal`
    })
  }

  const myChoiceText = myOption
    ? myOption === 'A'
      ? question?.optionA
      : question?.optionB
    : ''

  return (
    <View className={styles.page}>
      <View className={styles.header}>
        <Text className={styles.brand}>今天你几成</Text>
        <View className={styles.subHeader}>
          <Text className={styles.issue}>
            第 {serverDate ? getIssueNo(serverDate) : '—'} 期
          </Text>
          <Text className={styles.date}>
            {serverDate ? formatDateCNWithWeek(serverDate) : ''}
          </Text>
        </View>
      </View>

      {revealVisible && reveal && (
        <RevealBanner
          reveal={reveal}
          collapsed={revealCollapsed}
          onClose={handleCloseReveal}
          onClick={handleOpenReveal}
        />
      )}

      {loading && (
        <View className={styles.emptyCard}>
          <Text className={styles.emptyText}>正在出题…</Text>
        </View>
      )}

      {!loading && !question && (
        <View className={styles.emptyCard}>
          <Text className={styles.emptyEmoji}>😴</Text>
          <Text className={styles.emptyText}>今天还没出题，晚点再来看看</Text>
        </View>
      )}

      {!loading && question && !answered && (
        <View>
          <View className={styles.questionCard}>
            <Text className={styles.questionLabel}>全站同题 · 当天不变</Text>
            <Text className={styles.questionTitle}>{question.title}</Text>
            <View className={styles.vsRow}>
              <View className={styles.vsLine} />
              <View className={styles.vsDot}>VS</View>
              <View className={styles.vsLine} />
            </View>
            <OptionButton option='A' label={question.optionA} onClick={handleChoose} />
            <View className={styles.optionGap} />
            <OptionButton option='B' label={question.optionB} onClick={handleChoose} />
            <Text className={styles.timeHint}>点击即提交，不可反悔</Text>
          </View>
        </View>
      )}

      {!loading && question && answered && (
        <View className={styles.answeredCard}>
          <Text className={styles.answeredTip}>
            今天的题你已答过，选了
            <Text className={styles.answeredMy}>「{myChoiceText}」</Text>
          </Text>
          <View
            className={styles.viewResultBtn}
            onClick={() => Taro.navigateTo({ url: `/pages/result/index?questionId=${question.id}` })}
          >
            看今日战况
          </View>
        </View>
      )}
    </View>
  )
}

export default TodayPage
