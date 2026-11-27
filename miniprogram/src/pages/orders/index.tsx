import React, { useCallback, useState } from 'react'
import { View, Text } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import type { MyOrder } from '@/types'
import { api } from '@/services/api'
import { ensureLogin, isLoggedIn } from '@/services/cloud'
import styles from './index.module.scss'

/** 订单状态文案与配色（与服务端口径一致） */
const STATUS_MAP: Record<string, { text: string; cls: string }> = {
  pending: { text: '待发货', cls: 'pending' },
  shipped: { text: '已发货', cls: 'shipped' },
  done: { text: '已完成', cls: 'done' },
  refunded: { text: '已退款', cls: 'refunded' }
}

function formatTime(iso: string): string {
  // 服务端 created_at 是 UTC ISO，展示时换算到北京时间（UTC+8）
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return (iso || '').slice(0, 16).replace('T', ' ')
  const bj = new Date(d.getTime() + 8 * 3600 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} `
    + `${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`
}

const OrdersPage: React.FC = () => {
  const [orders, setOrders] = useState<MyOrder[]>([])
  const [loading, setLoading] = useState(false)
  const [loggedIn, setLoggedIn] = useState(isLoggedIn())
  const [logging, setLogging] = useState(false)

  const refresh = useCallback(() => {
    if (!isLoggedIn()) {
      setLoggedIn(false)
      setOrders([])
      return
    }
    setLoggedIn(true)
    setLoading(true)
    api
      .getMyOrders()
      .then((list) => setOrders(list || []))
      .catch((err) => console.error('[orders] getMyOrders failed:', err))
      .finally(() => setLoading(false))
  }, [])

  useDidShow(() => {
    refresh()
  })

  const handleLogin = () => {
    if (logging) return
    setLogging(true)
    ensureLogin()
      .then(() => {
        if (!isLoggedIn()) {
          Taro.showToast({ title: '登录失败，请稍后重试', icon: 'none' })
          return
        }
        refresh()
      })
      .finally(() => setLogging(false))
  }

  /** 复制快递单号，方便用户去快递平台查询 */
  const copyExpress = (no: string) => {
    if (!no) return
    Taro.setClipboardData({ data: no })
  }

  return (
    <View className={styles.page}>
      <View className={styles.hero}>
        <Text className={styles.heroTitle}>我的兑换</Text>
        <Text className={styles.heroSub}>实物兑换后由后台发货，这里可查看物流进度</Text>
      </View>

      {!loggedIn ? (
        <View className={styles.emptyCard}>
          <Text className={styles.emptyText}>登录后才能查看你的兑换记录</Text>
          <View className={styles.loginBtn} onClick={handleLogin}>
            {logging ? '登录中…' : '一键登录'}
          </View>
        </View>
      ) : orders.length === 0 ? (
        <View className={styles.emptyCard}>
          <Text className={styles.emptyText}>
            {loading ? '加载中…' : '还没有兑换记录，去积分中心看看吧'}
          </Text>
        </View>
      ) : (
        orders.map((o) => {
          const st = STATUS_MAP[o.status] || { text: o.status, cls: 'done' }
          return (
            <View key={o.orderNo} className={styles.orderCard}>
              <View className={styles.orderHead}>
                <Text className={styles.orderName}>{o.prizeName}</Text>
                <Text className={`${styles.statusTag} ${styles[st.cls]}`}>{st.text}</Text>
              </View>
              <View className={styles.orderRow}>
                <Text className={styles.rowLabel}>积分</Text>
                <Text className={styles.rowValue}>-{o.cost}</Text>
              </View>
              <View className={styles.orderRow}>
                <Text className={styles.rowLabel}>订单号</Text>
                <Text className={styles.rowValue}>{o.orderNo}</Text>
              </View>
              <View className={styles.orderRow}>
                <Text className={styles.rowLabel}>兑换时间</Text>
                <Text className={styles.rowValue}>{formatTime(o.createdAt)}</Text>
              </View>
              {o.receiverName && (
                <View className={styles.orderRow}>
                  <Text className={styles.rowLabel}>收货信息</Text>
                  <View className={styles.rowValue}>
                    <Text>{o.receiverName} · {o.receiverPhone}</Text>
                    <Text className={styles.addrText}>{o.receiverAddress}</Text>
                  </View>
                </View>
              )}
              {o.expressNo ? (
                <View className={styles.expressBox}>
                  <View className={styles.expressInfo}>
                    <Text className={styles.expressCompany}>{o.expressCompany}</Text>
                    <Text className={styles.expressNo}>{o.expressNo}</Text>
                  </View>
                  <Text className={styles.copyBtn} onClick={() => copyExpress(o.expressNo)}>
                    复制单号
                  </Text>
                </View>
              ) : o.status === 'pending' ? (
                <Text className={styles.tipText}>商家正在备货，发货后可在这里查看快递单号</Text>
              ) : null}
              {o.status === 'refunded' && (
                <Text className={styles.tipText}>该订单已退款，积分已回补（虚拟权益除外另行处理）</Text>
              )}
            </View>
          )
        })
      )}
    </View>
  )
}

export default OrdersPage
