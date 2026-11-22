import React from 'react'
import { View, Text, Button } from '@tarojs/components'
import styles from './index.module.scss'

interface SharePanelProps {
  /** 当前场景生成的分享标题（预览用） */
  shareTitle: string
}

/** 分享引导区：展示卡片标题预览 + 转发按钮（openType=share 走页面级 useShareAppMessage） */
const SharePanel: React.FC<SharePanelProps> = ({ shareTitle }) => {
  return (
    <View className={styles.panel}>
      <Text className={styles.hint}>把你的选择发给朋友，看看TA站哪边；点右上角「···」可分享到朋友圈</Text>
      <View className={styles.titlePreview}>
        <Text className={styles.titlePreviewLabel}>卡片标题</Text>
        <Text className={styles.titlePreviewText}>{shareTitle}</Text>
      </View>
      <Button className={styles.shareBtn} openType='share'>
        分享这一题
      </Button>
    </View>
  )
}

export default SharePanel
