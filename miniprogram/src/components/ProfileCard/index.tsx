import React from 'react'
import { View, Text } from '@tarojs/components'
import classnames from 'classnames'
import type { AiProfile } from '@/types'
import styles from './index.module.scss'

interface ProfileCardProps {
  profile: AiProfile | null
  loading?: boolean
}

/** AI 侧写卡：说中刚才那个动作，带固定标签池标签 + 固定免责 */
const ProfileCard: React.FC<ProfileCardProps> = ({ profile, loading }) => {
  if (loading) {
    return (
      <View className={classnames(styles.card, styles.loading)}>
        <Text className={styles.loadingText}>AI 正在看你的答案…</Text>
      </View>
    )
  }
  if (!profile) return null
  return (
    <View className={styles.card}>
      <View className={styles.header}>
        <Text className={styles.title}>AI 侧写</Text>
        <Text className={styles.tag}>{profile.tag}</Text>
      </View>
      <Text className={styles.text}>{profile.text}</Text>
      <Text className={styles.disclaimer}>{profile.disclaimer}</Text>
    </View>
  )
}

export default ProfileCard
