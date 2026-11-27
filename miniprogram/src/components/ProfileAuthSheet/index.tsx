import React, { useEffect, useState } from 'react'
import { View, Text, Input, Button, Image } from '@tarojs/components'
import Taro from '@tarojs/taro'
import classnames from 'classnames'
import { api } from '@/services/api'
import { API_BASE } from '@/config'
import styles from './index.module.scss'

interface ProfileAuthSheetProps {
  visible: boolean
  avatar?: string
  nickname?: string
  onClose: () => void
  onSaved?: (nickname: string) => void
}

/**
 * 登录后的头像昵称授权弹层。
 * 微信自 2022-10-25 起不再支持 getUserProfile 一键返回真实头像昵称，
 * 只能由用户点「头像」（chooseAvatar）和「昵称」（input type=nickname）从微信带出，
 * 这里把这两个动作收进一个半屏弹层，体验接近常规小程序的「授权弹窗」。
 */
const ProfileAuthSheet: React.FC<ProfileAuthSheetProps> = ({
  visible,
  avatar = '',
  nickname = '',
  onClose,
  onSaved
}) => {
  const [avatarSrc, setAvatarSrc] = useState('')
  const [nick, setNick] = useState('')
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    if (!visible) return
    setAvatarSrc(
      avatar ? (/^https?:|^cloud:/.test(avatar) ? avatar : API_BASE + avatar) : ''
    )
    setNick(nickname || '')
    setSaving(false)
    setUploading(false)
  }, [visible, avatar, nickname])

  if (!visible) return null

  /** 点头像：微信头像选择器 → 读 base64 上传到自己的服务端 */
  const handleChooseAvatar = (tempPath: string) => {
    if (!tempPath || uploading) return
    setUploading(true)
    try {
      const data = Taro.getFileSystemManager().readFileSync(tempPath, 'base64') as string
      const ext = (tempPath.split('.').pop() || 'png').toLowerCase()
      api
        .uploadAvatar({ data, ext })
        .then((res) => setAvatarSrc(API_BASE + res.url))
        .catch((err) => Taro.showToast({ title: err.message || '头像上传失败', icon: 'none' }))
        .finally(() => setUploading(false))
    } catch (err) {
      console.error('[ProfileAuthSheet] 头像读取失败:', err)
      Taro.showToast({ title: '头像读取失败', icon: 'none' })
      setUploading(false)
    }
  }

  const handleSave = async () => {
    const value = nick.trim()
    if (!value) {
      Taro.showToast({ title: '请先选择微信昵称', icon: 'none' })
      return
    }
    if (saving) return
    setSaving(true)
    try {
      await api.updateProfile(value)
      Taro.showToast({ title: '资料已保存', icon: 'success' })
      onSaved && onSaved(value)
      onClose()
    } catch (err) {
      Taro.showToast({ title: (err as Error).message || '保存失败', icon: 'none' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <View className={styles.mask} onClick={onClose}>
      <View className={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <View className={styles.header}>
          <Text className={styles.title}>完善你的资料</Text>
          <Text className={styles.close} onClick={onClose}>
            ×
          </Text>
        </View>
        <Text className={styles.desc}>用微信头像昵称，让结果页和短评更像你本人</Text>

        <View className={styles.avatarRow}>
          <Button
            className={styles.avatarBtn}
            openType='chooseAvatar'
            onChooseAvatar={(e) => handleChooseAvatar(e.detail.avatarUrl)}
          >
            {avatarSrc ? (
              <Image className={styles.avatarImg} src={avatarSrc} mode='aspectFill' />
            ) : (
              <View className={styles.avatarPh}>
                <Text>👤</Text>
              </View>
            )}
          </Button>
          <View className={styles.avatarInfo}>
            <Text className={styles.avatarTitle}>点击左侧头像，选择微信头像</Text>
            <Text className={styles.avatarHint}>头像昵称来自你的微信账号，保存后不可修改</Text>
          </View>
        </View>

        <Input
          className={styles.nickInput}
          type='nickname'
          placeholder='点击这里获取微信昵称'
          placeholderClass='input-ph'
          maxlength={20}
          value={nick}
          onInput={(e) => setNick(e.detail.value)}
        />

        <Button
          className={classnames(styles.saveBtn, (saving || uploading) && styles.disabled)}
          onClick={handleSave}
        >
          {saving ? '保存中…' : '保存并继续'}
        </Button>
        <Text className={styles.later} onClick={onClose}>
          稍后再说
        </Text>
      </View>
    </View>
  )
}

export default ProfileAuthSheet
