import React from 'react'
import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'
import styles from './index.module.scss'

/** 占位页：关于与隐私（后续替换为完整页面） */
const AboutPage: React.FC = () => {
  const goBack = () => {
    const pages = Taro.getCurrentPages()
    if (pages.length > 1) {
      Taro.navigateBack({ delta: 1 })
    } else {
      Taro.switchTab({ url: '/pages/today/index' })
    }
  }

  return (
    <View className={styles.page}>
      <View className={styles.backLink} onClick={goBack}>
        <Text>← 返回</Text>
      </View>
      <Text className={styles.emoji}>📖</Text>
      <Text className={styles.title}>关于与隐私</Text>
      <Text className={styles.hint}>功能正在开发中...</Text>
    </View>
  )
}

export default AboutPage
