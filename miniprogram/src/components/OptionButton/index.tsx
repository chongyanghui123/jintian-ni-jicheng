import React from 'react'
import { View, Text } from '@tarojs/components'
import classnames from 'classnames'
import type { OptionKey } from '@/types'
import styles from './index.module.scss'

interface OptionButtonProps {
  option: OptionKey
  label: string
  disabled?: boolean
  /** 提交中的选中高亮态 */
  selected?: boolean
  onClick: (option: OptionKey) => void
}

/** 选项大按钮：A 紫 / B 橙，点击即提交，不可反悔 */
const OptionButton: React.FC<OptionButtonProps> = ({ option, label, disabled, selected, onClick }) => {
  return (
    <View
      className={classnames(
        styles.button,
        option === 'A' ? styles.optionA : styles.optionB,
        disabled && styles.disabled,
        selected && styles.selected
      )}
      onClick={() => {
        if (!disabled) onClick(option)
      }}
    >
      <Text className={styles.key}>{option}</Text>
      <Text className={styles.label}>{label}</Text>
    </View>
  )
}

export default OptionButton
