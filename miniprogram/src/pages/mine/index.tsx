import React, { useState } from 'react'
import { Button, Image, Input, View, Text } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import type { MyStats } from '@/services/storage'
import type { MyReportItem, MyStatsData, PointsSummary, UserProfile, WeeklyReportData } from '@/types'
import { getMyStats, hasAnsweredToday } from '@/services/storage'
import { POINTS_RULES } from '@/data/points'
import { api } from '@/services/api'
import { ensureLogin } from '@/services/cloud'
import { API_BASE } from '@/config'
import styles from './index.module.scss'

/** 举报原因文案（与后台 REASON_LABELS 保持一致） */
const REASON_LABELS: Record<string, string> = {
  low_quality: '题目低质 / 引战',
  inappropriate: '内容不适',
  violation: '涉嫌违规',
  other: '其他'
}

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
  // 服务端统计：连答日历 + 少数派战绩 + AI 周报（接口异常静默，页面仍可用本地数据）
  const [myStatsData, setMyStatsData] = useState<MyStatsData | null>(null)
  const [weekly, setWeekly] = useState<WeeklyReportData | null>(null)
  // 我的举报反馈（后台处理结果会同步到这）
  const [myReports, setMyReports] = useState<MyReportItem[]>([])
  // 用户资料：头像昵称（微信授权填写能力，后台用户管理页同步展示）
  const [profile, setProfile] = useState<UserProfile | null>(null)

  useDidShow(() => {
    setStats(getMyStats())
    setAnsweredToday(hasAnsweredToday())
    api.getPoints().then(setPoints).catch((err) => console.error('[mine] getPoints failed:', err))
    api.getMyStats().then(setMyStatsData).catch(() => {})
    api.getWeeklyReport().then(setWeekly).catch(() => {})
    api.getMyReports().then((res) => setMyReports(res.reports || [])).catch(() => {})
    ensureLogin()
      .then(() => api.getProfile())
      .then(setProfile)
      .catch(() => {})
  })

  /** 头像显示地址：本地模式是 /uploads/... 相对路径，需拼 API 前缀 */
  const avatarSrc = profile?.avatar
    ? (profile.avatar.startsWith('http') || profile.avatar.startsWith('cloud://')
        ? profile.avatar
        : API_BASE + profile.avatar)
    : ''

  /** 资料是否已获取（头像+昵称齐全后锁定为只读展示） */
  const hasProfile = !!(profile?.nickname && avatarSrc)

  /** 头像选择回调：读 base64 上传，服务端落盘并写 users.avatar */
  const handleChooseAvatar = (tempPath: string) => {
    if (!tempPath) return
    try {
      const data = Taro.getFileSystemManager().readFileSync(tempPath, 'base64') as string
      const ext = (tempPath.split('.').pop() || 'png').toLowerCase()
      api.uploadAvatar({ data, ext })
        .then((res) => setProfile((p) => (p ? { ...p, avatar: res.url } : p)))
        .catch((err) => Taro.showToast({ title: err.message || '头像上传失败', icon: 'none' }))
    } catch (err) {
      console.error('[mine] 头像读取失败:', err)
      Taro.showToast({ title: '头像读取失败', icon: 'none' })
    }
  }

  /** 昵称填写：blur 时保存（type=nickname 唤起微信键盘昵称联想） */
  const handleNickname = (value: string) => {
    const nickname = (value || '').trim()
    if (!nickname || profile?.nickname === nickname) return
    api.updateProfile(nickname)
      .then(() => setProfile((p) => (p ? { ...p, nickname } : p)))
      .catch((err) => Taro.showToast({ title: err.message || '昵称保存失败', icon: 'none' }))
  }

  const goToday = () => Taro.switchTab({ url: '/pages/today/index' })
  const goPoints = () => Taro.navigateTo({ url: '/pages/points/index' })
  const goSubmit = () => Taro.navigateTo({ url: '/pages/submit/index' })
  const goFeedback = () => Taro.navigateTo({ url: '/pages/feedback/index' })
  const goAbout = () => Taro.navigateTo({ url: '/pages/about/index' })

  // 连答进度：本周期已连 n 天，满 7 领 +10
  const cycleDays = stats.streakDays % 7 === 0 && stats.streakDays > 0 ? 7 : stats.streakDays % 7

  // 连答日历：当月月历（周一为一周开始），标记服务端记录的已答日期
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const startWeek = (new Date(year, month, 1).getDay() + 6) % 7
  const answeredSet = new Set(myStatsData?.calendarDates || [])
  const pad = (n: number) => String(n).padStart(2, '0')
  const calCells: ({ n: number; on: boolean } | null)[] = []
  for (let i = 0; i < startWeek; i++) calCells.push(null)
  for (let d = 1; d <= daysInMonth; d++) {
    calCells.push({ n: d, on: answeredSet.has(`${year}-${pad(month + 1)}-${pad(d)}`) })
  }
  const answeredThisMonth = calCells.filter((c) => c?.on).length

  return (
    <View className={styles.page}>
      <View className={styles.hero}>
        <Text className={styles.heroTitle}>你的答题档案</Text>
        <Text className={styles.heroSub}>数据只来自你自己，不和别人比</Text>
      </View>

      {/* 资料卡：首次经微信填写能力一键带出本人头像昵称，获取后锁定只读 */}
      <View className={styles.profileCard}>
        {hasProfile ? (
          <>
            <Image className={styles.avatarImg} src={avatarSrc} mode='aspectFill' />
            <View className={styles.profileInfo}>
              <Text className={styles.nickText}>{profile?.nickname}</Text>
              <Text className={styles.profileHint}>头像昵称来自你的微信账号，不可修改</Text>
            </View>
          </>
        ) : (
          <>
            <Button
              className={styles.avatarBtn}
              openType='chooseAvatar'
              onChooseAvatar={(e) => handleChooseAvatar(e.detail.avatarUrl)}
            >
              <View className={styles.avatarPlaceholder}>
                <Text>👤</Text>
              </View>
            </Button>
            <View className={styles.profileInfo}>
              <Input
                className={styles.nickInput}
                type='nickname'
                placeholder='点击获取微信头像和昵称'
                maxlength={20}
                onBlur={(e) => handleNickname(e.detail.value)}
              />
              <Text className={styles.profileHint}>
                头像点左图一键带出微信头像；昵称点输入框选微信昵称，确认后不可修改
              </Text>
            </View>
          </>
        )}
      </View>

      {/* 积分卡 */}
      <View className={styles.pointsCard} onClick={goPoints}>
        <View className={styles.pointsLeft}>
          <Text className={styles.pointsBalance}>{points ? points.balance : 0}</Text>
          <Text className={styles.pointsLabel}>我的积分 · 今日已得 {points ? points.earnedToday : 0}</Text>
          {points && (points.titles.length > 0 || points.skin?.active) && (
            <View className={styles.titlesRow}>
              {points.skin?.active && (
                <Text key='skin' className={styles.titleChip}>
                  夜航皮肤 · 至 {points.skin.expiresAt.slice(5, 10).replace('-', '/')}
                </Text>
              )}
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
              {myStatsData ? myStatsData.minorityRate : stats.minorityRate}%
            </Text>
            <Text className={styles.statLabel}>
              站上少数派 {myStatsData ? `${myStatsData.minorityCount} 次` : '占比'}
            </Text>
          </View>
          <View className={styles.statItem}>
            <Text className={styles.statValue}>{stats.avgDuration}s</Text>
            <Text className={styles.statLabel}>平均决策时长</Text>
          </View>
        </View>
      </View>

      {/* 连答日历：月历打卡视图 */}
      <View className={styles.statsCard}>
        <View className={styles.calHeader}>
          <Text className={styles.calTitle}>
            连答日历 · {year} 年 {month + 1} 月
          </Text>
          <Text className={styles.calHint}>本月已答 {answeredThisMonth} 天</Text>
        </View>
        <View className={styles.calGrid}>
          {['一', '二', '三', '四', '五', '六', '日'].map((d) => (
            <Text key={d} className={styles.calDow}>
              {d}
            </Text>
          ))}
          {calCells.map((c, i) =>
            c ? (
              <Text
                key={i}
                className={`${styles.calDay} ${c.on ? styles.calDayOn : ''} ${
                  c.n === now.getDate() ? styles.calDayToday : ''
                }`}
              >
                {c.n}
              </Text>
            ) : (
              <Text key={i} className={styles.calDay} />
            )
          )}
        </View>
      </View>

      {/* AI 周报：连答满 7 天解锁（服务端缓存，本周只生成一次） */}
      {weekly && (
        <View className={styles.weeklyCard}>
          <View className={styles.weeklyHead}>
            <Text className={styles.weeklyTitle}>📻 本周人格报告</Text>
            {weekly.unlocked ? (
              <Text className={styles.weeklyMeta}>
                答 {weekly.days} 天 · 少数派 {weekly.minorityCount} 次
              </Text>
            ) : (
              <Text className={styles.weeklyMetaLocked}>连答满 7 天解锁 · {weekly.streak ?? 0}/7</Text>
            )}
          </View>
          <Text className={weekly.unlocked ? styles.weeklyText : styles.weeklyTextLocked}>
            {weekly.unlocked
              ? weekly.report
              : '老航的周更电台：连答满 7 天，为你复盘这一周的选择。'}
          </Text>
        </View>
      )}

      {/* 举报反馈：后台处理结果说明会同步到这里 */}
      {myReports.length > 0 && (
        <View className={styles.statsCard}>
          <Text className={styles.reportTitle}>举报反馈</Text>
          {myReports.map((r) => (
            <View key={r.id} className={styles.reportItem}>
              <View className={styles.reportHead}>
                <Text className={styles.reportReason}>{REASON_LABELS[r.reason] || '举报'}</Text>
                {r.status === 'closed' ? (
                  <Text className={styles.reportDone}>已处理</Text>
                ) : (
                  <Text className={styles.reportPending}>处理中</Text>
                )}
              </View>
              <Text className={styles.reportResult}>
                {r.status === 'closed'
                  ? r.result || '已核实处理，感谢反馈'
                  : '已收到你的举报，运营会尽快核实'}
              </Text>
            </View>
          ))}
        </View>
      )}

      <View className={styles.entryCard} onClick={goSubmit}>
        <Text className={styles.entryText}>投稿题目</Text>
        <Text className={styles.entryArrow}>›</Text>
      </View>

      <View className={styles.entryCard} onClick={goFeedback}>
        <Text className={styles.entryText}>意见反馈</Text>
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
