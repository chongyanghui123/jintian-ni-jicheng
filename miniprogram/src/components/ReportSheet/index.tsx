import React, { useEffect, useState } from 'react'
import { View, Text, Input, Button } from '@tarojs/components'
import Taro from '@tarojs/taro'
import classnames from 'classnames'
import type { ReportReason } from '@/types'
import { api } from '@/services/api'
import styles from './index.module.scss'

interface ReportSheetProps {
  visible: boolean
  targetType: 'question' | 'comment'
  targetId: string
  onClose: () => void
  onReported?: () => void
}

const REASONS: Array<{ key: ReportReason; label: string }> = [
  { key: 'low_quality', label: '题目低质 / 引战' },
  { key: 'inappropriate', label: '内容不适' },
  { key: 'violation', label: '涉嫌违规' },
  { key: 'other', label: '其他' }
]

/** 举报弹层（最小版）：单选原因 + 40 字补充说明，落库即可 */
const ReportSheet: React.FC<ReportSheetProps> = ({ visible, targetType, targetId, onClose, onReported }) => {
  const [reason, setReason] = useState<ReportReason>('low_quality')
  const [detail, setDetail] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (visible) {
      setReason('low_quality')
      setDetail('')
      setSubmitting(false)
    }
  }, [visible])

  if (!visible) return null

  const handleSubmit = async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      await api.reportContent({
        targetType,
        targetId,
        reason,
        detail: detail.trim() || undefined
      })
      Taro.showToast({ title: '已收到举报，会尽快处理', icon: 'success' })
      onReported && onReported()
      onClose()
    } catch (err) {
      console.error('[ReportSheet] submit failed:', err)
      Taro.showToast({ title: '提交失败，请稍后再试', icon: 'none' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <View className={styles.mask} onClick={onClose}>
      <View className={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <View className={styles.header}>
          <Text className={styles.title}>举报这道题</Text>
          <Text className={styles.close} onClick={onClose}>×</Text>
        </View>
        <View className={styles.reasonList}>
          {REASONS.map((item) => (
            <View
              key={item.key}
              className={classnames(styles.reasonItem, reason === item.key && styles.reasonActive)}
              onClick={() => setReason(item.key)}
            >
              <View className={classnames(styles.radio, reason === item.key && styles.radioActive)} />
              <Text className={styles.reasonLabel}>{item.label}</Text>
            </View>
          ))}
        </View>
        <View className={styles.detailWrap}>
          <Input
            className={styles.detailInput}
            placeholder='补充说明（选填，40 字以内）'
            maxlength={40}
            value={detail}
            onInput={(e) => setDetail(e.detail.value)}
          />
        </View>
        <Button
          className={classnames(styles.submitBtn, submitting && styles.submitting)}
          onClick={handleSubmit}
        >
          {submitting ? '提交中…' : '提交举报'}
        </Button>
      </View>
    </View>
  )
}

export default ReportSheet
