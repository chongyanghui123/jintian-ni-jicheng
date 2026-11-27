import React, { useCallback, useState } from 'react'
import { View, Text, Input, Textarea } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import type { AppConfig, Submission } from '@/types'
import { api, loadAppConfig } from '@/services/api'
import { ensureLogin, isLoggedIn } from '@/services/cloud'
import { formatDateCN, getTodayDate } from '@/utils/date'
import ProfileAuthSheet from '@/components/ProfileAuthSheet'
import styles from './index.module.scss'

const SubmitPage: React.FC = () => {
  const [title, setTitle] = useState('')
  const [optionA, setOptionA] = useState('')
  const [optionB, setOptionB] = useState('')
  const [signature, setSignature] = useState('')
  const [busy, setBusy] = useState(false)
  const [subs, setSubs] = useState<Submission[]>([])
  const [config, setConfig] = useState<AppConfig | null>(null)
  /** 登录成功后资料不全时弹头像昵称卡（任何入口登录都统一走这里） */
  const [profileSheet, setProfileSheet] = useState<{ nickname?: string; avatar?: string } | null>(null)

  const refresh = useCallback(() => {
    api
      .getMySubmissions()
      .then(setSubs)
      .catch((err) => console.error('[submit] getMySubmissions failed:', err))
  }, [])

  useDidShow(() => {
    refresh()
    loadAppConfig().then(setConfig).catch(() => {})
  })

  // 北京日期口径：与服务端每日限额一致（不能用 UTC 日期，否则 0~8 点会错位）
  const dailyLimit = config ? config.submitDailyLimit : 3
  const moduleOff = config ? !config.modules.submit : false
  const usedToday = subs.filter((s) => s.createdAt.slice(0, 10) === getTodayDate()).length
  const left = Math.max(0, dailyLimit - usedToday)

  const onSubmit = () => {
    if (busy) return
    if (!isLoggedIn()) {
      Taro.showModal({
        title: '登录后才能投稿',
        content: '投稿记录跟你的微信账号绑定，审核结果和采纳奖励才能发到你名下。',
        confirmText: '一键登录',
        cancelText: '取消',
        success: async (res) => {
          if (!res.confirm) return
          await ensureLogin()
          if (!isLoggedIn()) {
            Taro.showToast({ title: '登录失败，请稍后重试', icon: 'none' })
            return
          }
          // 登录成功统一检查资料，昵称/头像缺失就弹授权卡
          api.getProfile()
            .then((p) => {
              if (!p.nickname || !p.avatar) setProfileSheet({ nickname: p.nickname, avatar: p.avatar })
            })
            .catch(() => {})
          onSubmit()
        }
      })
      return
    }
    if (left <= 0) {
      Taro.showToast({ title: `今天已经投了 ${dailyLimit} 道，明天再来`, icon: 'none' })
      return
    }
    setBusy(true)
    api
      .submitQuestion({
        title,
        optionA,
        optionB,
        signature: signature.trim() || undefined
      })
      .then(() => {
        setTitle('')
        setOptionA('')
        setOptionB('')
        setSignature('')
        refresh()
        Taro.showToast({ title: '已提交，等审核结果', icon: 'success' })
      })
      .catch((err) => Taro.showToast({ title: err.message || '提交失败', icon: 'none' }))
      .finally(() => setBusy(false))
  }

  const copyForReview = () => {
    // 导出投稿 JSON（可粘贴到运营后台"批量导入投稿"进行人工审核）
    Taro.setClipboardData({
      data: JSON.stringify(subs, null, 2),
      success: () => Taro.showToast({ title: '已复制，可发给运营审核', icon: 'none' })
    })
  }

  const statusBadge = (s: Submission) => {
    if (s.status === 'approved') {
      return (
        <Text className={styles.badgeOk}>
          {s.showDate ? `已通过 · ${formatDateCN(s.showDate)} 上墙` : '已通过 · 待排期'}
        </Text>
      )
    }
    if (s.status === 'rejected') return <Text className={styles.badgeBad}>未通过 · {s.rejectReason}</Text>
    return <Text className={styles.badgePending}>审核中</Text>
  }

  return (
    <View className={styles.page}>
      <View className={styles.hero}>
        <Text className={styles.heroTitle}>投稿题目</Text>
        <Text className={styles.heroSub}>
          你出的题可能被全站答；每天限 {dailyLimit} 道，今天还剩 {left} 道
        </Text>
      </View>

      {moduleOff ? (
        <View className={styles.formCard}>
          <Text className={styles.label}>投稿暂未开放</Text>
          <Text className={styles.formNote}>运营暂时关闭了投稿入口，恢复后这里会自动开放。</Text>
        </View>
      ) : (
      <View className={styles.formCard}>
        <Text className={styles.label}>题干（4~40 字）</Text>
        <Textarea
          className={styles.textarea}
          value={title}
          maxlength={40}
          placeholderClass='input-ph'
          placeholder='例如：加班到十点，你会先给家里打个电话吗'
          onInput={(e) => setTitle(e.detail.value)}
        />

        <Text className={styles.label}>选项 A（1~16 字）</Text>
        <Input
          className={styles.input}
          value={optionA}
          maxlength={16}
          placeholderClass='input-ph'
          placeholder='例如：会'
          onInput={(e) => setOptionA(e.detail.value)}
        />

        <Text className={styles.label}>选项 B（1~16 字）</Text>
        <Input
          className={styles.input}
          value={optionB}
          maxlength={16}
          placeholderClass='input-ph'
          placeholder='例如：先不打，到家再说'
          onInput={(e) => setOptionB(e.detail.value)}
        />

        <Text className={styles.label}>署名（可选，2~8 字；留空显示"网友投稿"）</Text>
        <Input
          className={styles.input}
          value={signature}
          maxlength={8}
          placeholderClass='input-ph'
          placeholder='例如：夜航员'
          onInput={(e) => setSignature(e.detail.value)}
        />

        <View className={styles.submitBtn} onClick={onSubmit}>
          {busy ? '提交中…' : '提交'}
        </View>
        <Text className={styles.formNote}>
          机器审核后进入人工审核；通过会安排上墙时间并通知你，未通过会写明原因。不留联系方式、不写品牌和营销内容。
        </Text>
      </View>
      )}

      <View className={styles.sectionTitle}>
        我的投稿（{subs.length}）
        {subs.length > 0 && (
          <Text className={styles.copyLink} onClick={copyForReview}>
            复制 JSON 给运营
          </Text>
        )}
      </View>
      <View className={styles.subsCard}>
        {subs.length > 0 ? (
          subs.map((s) => (
            <View key={s.id} className={styles.subItem}>
              <Text className={styles.subTitle}>{s.title}</Text>
              <Text className={styles.subOptions}>
                A {s.optionA} / B {s.optionB}
              </Text>
              <View className={styles.subMeta}>
                <Text className={styles.subSign}>{s.signature || '网友投稿'}</Text>
                {statusBadge(s)}
              </View>
            </View>
          ))
        ) : (
          <Text className={styles.subsEmpty}>还没有投稿，出第一道题试试</Text>
        )}
      </View>

      <ProfileAuthSheet
        visible={!!profileSheet}
        avatar={profileSheet?.avatar}
        nickname={profileSheet?.nickname}
        onClose={() => setProfileSheet(null)}
        onSaved={() => setProfileSheet(null)}
      />
    </View>
  )
}

export default SubmitPage
