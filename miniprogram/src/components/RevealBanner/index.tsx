import React from 'react'
import { View, Text } from '@tarojs/components'
import classnames from 'classnames'
import type { RevealData } from '@/types'
import { optionRatio } from '@/services/storage'
import styles from './index.module.scss'

interface RevealBannerProps {
  reveal: RevealData
  collapsed?: boolean
  onClose: () => void
  onClick: () => void
}

/**
 * 昨日揭晓条：次日首次进入展示一次，可手动关闭；
 * 页面滚动时收成一行小字，点击才展开——揭晓不挡在题前面。
 */
const RevealBanner: React.FC<RevealBannerProps> = ({ reveal, collapsed, onClose, onClick }) => {
  const { question, votesA, votesB, myOption, offline } = reveal
  if (!question) return null

  const pctA = optionRatio(votesA, votesB, 'A')
  const myText = myOption ? (myOption === 'A' ? question.optionA : question.optionB) : ''
  const myPct = myOption ? optionRatio(votesA, votesB, myOption) : 0

  return (
    <View
      className={classnames(styles.banner, collapsed && styles.collapsed)}
      onClick={onClick}
    >
      <View className={styles.main}>
        <Text className={styles.badge}>昨日揭晓</Text>
        {collapsed ? (
          <Text className={styles.collapsedText}>
            {formatPct(pctA)} 比 {formatPct(100 - pctA)}，点开回看
          </Text>
        ) : (
          <Text className={styles.text}>
            {question.title.length > 14 ? `${question.title.slice(0, 14)}…` : question.title}
            {' '}
            {formatPct(pctA)} 比 {formatPct(100 - pctA)}
            {myOption ? `，你选的${myText}${myPct >= 50 ? '赢了' : '输了'}` : ''}
            {offline ? '（截至你离开时）' : ''}
          </Text>
        )}
      </View>
      <View
        className={styles.close}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
      >
        <Text className={styles.closeIcon}>×</Text>
      </View>
    </View>
  )
}

function formatPct(p: number): string {
  return `${p}%`
}

export default RevealBanner
