import React, { useCallback, useState } from 'react'
import { View, Text, Input, Textarea } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import type { Submission } from '@/types'
import { api } from '@/services/api'
import styles from './index.module.scss'

const SUBMIT_DAILY_LIMIT = 3

const SubmitPage: React.FC = () => {
  const [title, setTitle] = useState('')
  const [optionA, setOptionA] = useState('')
  const [optionB, setOptionB] = useState('')
  const [signature, setSignature] = useState('')
  const [busy, setBusy] = useState(false)
  const [subs, setSubs] = useState<Submission[]>([])

  const refresh = useCallback(() => {
    api
      .getMySubmissions()
      .then(setSubs)
      .catch((err) => console.error('[submit] getMySubmissions failed:', err))
  }, [])

  useDidShow(() => {
    refresh()
  })

  const usedToday = subs.filter((s) => s.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10))
    .length
  const left = Math.max(0, SUBMIT_DAILY_LIMIT - usedToday)

  const onSubmit = () => {
    if (busy) return
    if (left <= 0) {
      Taro.showToast({ title: '今天已经投了 3 道，明天再来', icon: 'none' })
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
    if (s.status === 'approved') return <Text className={styles.badgeOk}>已通过 · {s.showDate} 上墙</Text>
    if (s.status === 'rejected') return <Text className={styles.badgeBad}>未通过 · {s.rejectReason}</Text>
    return <Text className={styles.badgePending}>审核中</Text>
  }

  return (
    <View className={styles.page}>
      <View className={styles.hero}>
        <Text className={styles.heroTitle}>投稿题目</Text>
        <Text className={styles.heroSub}>
          你出的题可能被全站答；每天限 {SUBMIT_DAILY_LIMIT} 道，今天还剩 {left} 道
        </Text>
      </View>

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
    </View>
  )
}

export default SubmitPage
