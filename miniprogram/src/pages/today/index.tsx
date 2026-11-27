import React, { useEffect, useRef, useState } from 'react'
import { View, Text } from '@tarojs/components'
import Taro, { useDidShow, usePageScroll, useShareAppMessage, useShareTimeline } from '@tarojs/taro'
import type { OptionKey, Question, RevealData } from '@/types'
import { api, loadAppConfig } from '@/services/api'
import { ensureLogin, isLoggedIn } from '@/services/cloud'
import { SUBSCRIBE_TMPL_ID } from '@/config'
import shareCard from '@/assets/share-card.jpg'
import { loadShareImage } from '@/utils/shareImage'
import {
  isLoginTipClosed,
  isMinorNoticeShown,
  isRevealRead,
  markLoginTipClosed,
  markMinorNoticeShown,
  markRevealRead,
  saveAnswerRecord
} from '@/services/storage'
import { formatDateCNWithWeek, getIssueNo, getTodayDate } from '@/utils/date'
import RevealBanner from '@/components/RevealBanner'
import ProfileAuthSheet from '@/components/ProfileAuthSheet'
import OptionButton from '@/components/OptionButton'
import styles from './index.module.scss'

const TodayPage: React.FC = () => {
  const [loading, setLoading] = useState(true)
  const [question, setQuestion] = useState<Question | null>(null)
  const [serverDate, setServerDate] = useState<string>('')
  const [answered, setAnswered] = useState(false)
  const [myOption, setMyOption] = useState<OptionKey | null>(null)
  const [submitting, setSubmitting] = useState(false)
  /** 提交中的选项高亮 */
  const [chosen, setChosen] = useState<OptionKey | null>(null)
  const [reveal, setReveal] = useState<RevealData | null>(null)
  const [revealVisible, setRevealVisible] = useState(false)
  const [revealCollapsed, setRevealCollapsed] = useState(false)
  /** 登录态与「登录引导条」状态：只提示不拦截浏览，关闭后当天不再显示 */
  const [loggedIn, setLoggedIn] = useState(isLoggedIn())
  const [loginTipClosed, setLoginTipClosed] = useState(isLoginTipClosed(getTodayDate()))
  /** 登录后的头像昵称授权弹层（资料不全时才弹） */
  const [profileSheet, setProfileSheet] = useState<{ nickname?: string; avatar?: string } | null>(null)
  /** 首页公告（后台「运营设置」可开关与改文案） */
  const [announcement, setAnnouncement] = useState<{ enabled: boolean; text: string } | null>(null)

  /** 题目曝光时间戳：决策时长的计时起点 */
  const shownAtRef = useRef(0)
  /** 计时对应的题目 ID：换题才重新计时，切 tab/页面复显不清零 */
  const timerQidRef = useRef('')

  /** 分享卡片标题实时取最新题目；配当日 AI 定制传播图（失败退默认图） */
  const shareTitleRef = useRef('今天这题有点难选，你来')
  const shareImageRef = useRef<string>(shareCard)
  useShareAppMessage(() => ({
    title: shareTitleRef.current,
    path: '/pages/today/index',
    imageUrl: shareImageRef.current
  }))
  useShareTimeline(() => ({
    title: shareTitleRef.current,
    imageUrl: shareImageRef.current
  }))

  /** 题目一确定就去取当日分享图 */
  useEffect(() => {
    if (!question?.id) return
    let alive = true
    loadShareImage(question.id).then((path) => {
      if (alive) shareImageRef.current = path
    })
    return () => { alive = false }
  }, [question?.id])

  const loadData = async () => {
    try {
      const res = await api.getTodayQuestion()
      setServerDate(res.serverDate)
      setQuestion(res.question)
      setAnswered(res.answered)
      setMyOption(res.myOption)
      if (!res.answered) {
        // 只在「新题首次曝光」时计时；切 tab 回来不复位，否则会把看题时间算成秒选
        const qid = res.question?.id || ''
        if (timerQidRef.current !== qid) {
          shownAtRef.current = Date.now()
          timerQidRef.current = qid
        }
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
    loadAppConfig()
      .then((c) => { if (c) setAnnouncement(c.announcement) })
      .catch(() => {})
    // 回到页面时同步登录态（可能刚在「我的」页登录/退出）
    setLoggedIn(isLoggedIn())
    setLoginTipClosed(isLoginTipClosed(getTodayDate()))
    // 不再进页静默登录：答题前显式弹「微信一键登录」，用户确认后才绑定 openid
  })

  /** 微信一键登录（确认弹窗 → code2session）；返回是否已登录 */
  const requestLogin = async (): Promise<boolean> => {
    const { confirm } = await Taro.showModal({
      title: '微信一键登录',
      content: '登录后答题记录和积分都归到你名下，也保证每人每天一票。',
      confirmText: '一键登录',
      cancelText: '先看看'
    })
    if (!confirm) return false
    await ensureLogin()
    if (!isLoggedIn()) {
      Taro.showToast({ title: '登录失败，请稍后重试', icon: 'none' })
      return false
    }
    setLoggedIn(true)
    setLoginTipClosed(true)
    // 登录后按 openid 重新拉一次，避免"在别的设备已答过"时状态不同步
    loadData()
    // 资料不全就弹头像昵称授权（微信只允许用户主动选择，不能静默获取）
    api.getProfile()
      .then((p) => {
        if (!p.nickname || !p.avatar) setProfileSheet({ nickname: p.nickname, avatar: p.avatar })
      })
      .catch(() => {})
    return true
  }

  const handleCloseLoginTip = () => {
    markLoginTipClosed(getTodayDate())
    setLoginTipClosed(true)
  }

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
    // 答题门禁：未登录先弹微信一键登录（绑定 openid），登录成功才放行提交
    if (!isLoggedIn()) {
      const ok = await requestLogin()
      if (!ok) return
    }
    setChosen(option)
    setSubmitting(true)
    // 订阅消息授权必须在用户点击的同步链路里发起；未配置模板 ID 时静默跳过
    if (SUBSCRIBE_TMPL_ID) {
      // 注：Taro 类型定义的 AtLeastOne 有缺陷，tmplIds/entityIds 均必填；weapp 会忽略 entityIds
      Taro.requestSubscribeMessage({ tmplIds: [SUBSCRIBE_TMPL_ID], entityIds: [] })
        .then((res) => {
          if (res[SUBSCRIBE_TMPL_ID] === 'accept') {
            api.subscribeNotify().catch(() => {})
          }
        })
        .catch(() => {})
    }
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
      if (stats.earnedDraws && stats.earnedDraws > 0) {
        // 抽奖次数由服务端发放，仅作告知
        Taro.showToast({
          title: `抽奖次数 +${stats.earnedDraws}${stats.earnedReason ? `（${stats.earnedReason}）` : ''}`,
          icon: 'none',
          duration: 2000
        })
      }
      Taro.navigateTo({ url: `/pages/result/index?questionId=${question.id}` })
    } catch (err) {
      console.error('[Today] submitVote failed:', err)
      setChosen(null)
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

      {announcement && announcement.enabled && announcement.text && (
        <View className={styles.announceBar}>
          <Text className={styles.announceIcon}>📢</Text>
          <Text className={styles.announceText}>{announcement.text}</Text>
        </View>
      )}

      {!loggedIn && !loginTipClosed && (
        <View className={styles.loginBar}>
          <Text className={styles.loginBarText}>登录后保存战绩与积分</Text>
          <View className={styles.loginBarBtn} onClick={requestLogin}>
            一键登录
          </View>
          <Text className={styles.loginBarClose} onClick={handleCloseLoginTip}>
            ✕
          </Text>
        </View>
      )}

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
            <Text className={styles.questionTitle}>{question.title}</Text>
            <View className={styles.vsRow}>
              <View className={styles.vsLine} />
              <View className={styles.vsDot}>VS</View>
              <View className={styles.vsLine} />
            </View>
            <OptionButton option='A' label={question.optionA} selected={chosen === 'A'} onClick={handleChoose} />
            <View className={styles.optionGap} />
            <OptionButton option='B' label={question.optionB} selected={chosen === 'B'} onClick={handleChoose} />
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

      <ProfileAuthSheet
        visible={!!profileSheet}
        avatar={profileSheet?.avatar}
        nickname={profileSheet?.nickname}
        onClose={() => setProfileSheet(null)}
      />
    </View>
  )
}

export default TodayPage
