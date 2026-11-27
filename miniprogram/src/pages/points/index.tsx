import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Image, Input, View, Text } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import type {
  AppConfig,
  PointsSummary,
  Prize,
  WheelData,
  WheelDraw,
  WheelDrawResult,
  WheelPrize
} from '@/types'
import { api, loadAppConfig } from '@/services/api'
import { ensureLogin, isLoggedIn } from '@/services/cloud'
import { API_BASE } from '@/config'
import ProfileAuthSheet from '@/components/ProfileAuthSheet'
import styles from './index.module.scss'

/** 商品图：服务端返回 /uploads/prizes/xxx 相对路径，拼 API 域名 */
function prizeImageSrc(image: string): string {
  if (!image) return ''
  return image.startsWith('http') ? image : API_BASE + image
}

function formatTime(iso: string): string {
  // 服务端 created_at 是 UTC ISO，展示时换算到北京时间（UTC+8）
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ')
  const bj = new Date(d.getTime() + 8 * 3600 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} `
    + `${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`
}

/** 跑马灯外围格数（3×3 去掉中心） */
const MARQUEE_SLOTS = 8
/** 8 个外围格按顺时针编号后，在 3×3 网格里的渲染顺序；-1 是中心抽奖按钮 */
const GRID_ORDER = [0, 1, 2, 7, -1, 3, 6, 5, 4]

/** 奖品格图标：文字兜底，后台配了图片则优先用图 */
function prizeIcon(type: WheelPrize['type']): string {
  if (type === 'points') return '🪙'
  if (type === 'physical') return '🎁'
  return '🍀'
}

const PointsPage: React.FC = () => {
  const [summary, setSummary] = useState<PointsSummary | null>(null)
  const [prizes, setPrizes] = useState<Prize[]>([])
  const [redeemingId, setRedeemingId] = useState<string | null>(null)
  // 积分与兑换记录跟微信账号绑定，未登录只看登录引导
  const [loggedIn, setLoggedIn] = useState(isLoggedIn())
  const [logging, setLogging] = useState(false)
  /** 登录成功后资料不全时弹头像昵称卡（任何入口登录都统一走这里） */
  const [profileSheet, setProfileSheet] = useState<{ nickname?: string; avatar?: string } | null>(null)
  // 转盘抽奖
  const [wheel, setWheel] = useState<WheelData | null>(null)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [drawing, setDrawing] = useState(false)
  /** 跑马灯当前高亮格（0-7，顺时针编号） */
  const [highlight, setHighlight] = useState(-1)
  /** 中奖格下标：跑马灯停下后金底闪烁，关掉弹窗也能看到中的是哪个 */
  const [hitIndex, setHitIndex] = useState<number | null>(null)
  const [result, setResult] = useState<WheelDrawResult | null>(null)
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [contactAddress, setContactAddress] = useState('')
  const [contactBusy, setContactBusy] = useState(false)

  const refresh = useCallback(() => {
    if (!isLoggedIn()) {
      setLoggedIn(false)
      return
    }
    setLoggedIn(true)
    api
      .getPoints()
      .then(setSummary)
      .catch((err) => console.error('[points] getPoints failed:', err))
    api
      .getPrizes()
      .then(setPrizes)
      .catch((err) => console.error('[points] getPrizes failed:', err))
    api
      .getWheel()
      .then(setWheel)
      .catch((err) => console.error('[points] getWheel failed:', err))
    loadAppConfig().then(setConfig).catch(() => {})
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
        // 登录成功统一检查资料，昵称/头像缺失就弹授权卡
        api.getProfile()
          .then((p) => {
            if (!p.nickname || !p.avatar) setProfileSheet({ nickname: p.nickname, avatar: p.avatar })
          })
          .catch(() => {})
      })
      .finally(() => setLogging(false))
  }

  const onRedeem = (prize: Prize) => {
    if (redeemingId) return
    const balance = summary ? summary.balance : 0
    if (prize.redeemedThisMonth >= prize.monthlyLimit) {
      Taro.showToast({ title: '本月已兑过，下个月再来', icon: 'none' })
      return
    }
    if (prize.stock <= 0) {
      Taro.showToast({ title: '已被兑光了，下次早点来', icon: 'none' })
      return
    }
    if (balance < prize.cost) {
      Taro.showToast({ title: `积分不够，还差 ${prize.cost - balance} 分`, icon: 'none' })
      return
    }
    Taro.showModal({
      title: '确认兑换',
      content: `用 ${prize.cost} 积分兑换「${prize.name}」？积分不退，兑换后立即发放。`,
      confirmText: '兑换',
      cancelText: '再想想',
      success: (res) => {
        if (!res.confirm) return
        setRedeemingId(prize.id)
        api
          .redeemPrize(prize.id)
          .then((result) => {
            Taro.showToast({ title: '兑换成功，已发放', icon: 'success' })
            console.info('[points] redeemed:', result.orderNo)
            refresh()
          })
          .catch((err) => {
            Taro.showToast({ title: err.message || '兑换失败，请重试', icon: 'none' })
          })
          .finally(() => setRedeemingId(null))
      }
    })
  }

  const balance = summary ? summary.balance : 0
  const wheelEnabled =
    (config ? config.modules.wheel : true) && (wheel ? wheel.enabled : true)
  const wheelPrizes = wheel?.prizes || []
  const drawChances = wheel ? wheel.balance : (summary?.drawChances ?? 0)
  const perAnswer = config ? config.drawPerAnswer : 1
  const streakBonus = config ? config.drawStreak7Bonus : 3
  const expireTipDays = config ? config.pointsExpireTipDays : 90
  const validDays = config ? config.pointsValidDays : 365
  const prizesEnabled = config ? config.modules.prizes : true

  /** 跑马灯 8 格：奖品不足 8 个用「谢谢参与」占位，超出只展示前 8 个 */
  const marqueePrizes = wheelPrizes.slice(0, MARQUEE_SLOTS)
  while (marqueePrizes.length < MARQUEE_SLOTS) {
    marqueePrizes.push({
      id: `__empty_${marqueePrizes.length}`,
      name: '谢谢参与',
      type: 'none',
      value: 0,
      stock: -1
    })
  }

  /* ---------- 跑马灯动画：点击即预热匀速跑，拿到结果后绕 3 圈减速停在中奖格 ---------- */
  const marqueeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const marqueePos = useRef(0)
  const marqueePhase = useRef<'idle' | 'warmup' | 'settle'>('idle')
  /** 同步锁：防快速连点并发发起两次抽奖（state 更新是异步的，拦不住双击） */
  const drawLockRef = useRef(false)
  /** 页面是否还活着：卸载后接口回调不再改状态 */
  const aliveRef = useRef(true)

  const stopMarquee = useCallback(() => {
    if (marqueeTimer.current) {
      clearTimeout(marqueeTimer.current)
      marqueeTimer.current = null
    }
    marqueePhase.current = 'idle'
  }, [])

  // 页面卸载时清掉定时器并标记，避免卸载后继续 setState
  useEffect(() => () => {
    aliveRef.current = false
    stopMarquee()
  }, [stopMarquee])

  /** 预热：接口还没返回时先匀速跑，点下去立刻有反应 */
  const startMarquee = useCallback(() => {
    stopMarquee()
    marqueePhase.current = 'warmup'
    const tick = () => {
      marqueePos.current = (marqueePos.current + 1) % MARQUEE_SLOTS
      setHighlight(marqueePos.current)
      if (marqueePhase.current !== 'warmup') return
      marqueeTimer.current = setTimeout(tick, 70)
    }
    marqueeTimer.current = setTimeout(tick, 70)
  }, [stopMarquee])

  /** 减速停下：再绕 3 圈，二次缓动让末段明显变慢 */
  const settleMarquee = useCallback(
    (targetIdx: number, done: () => void) => {
      stopMarquee()
      marqueePhase.current = 'settle'
      const total =
        MARQUEE_SLOTS * 3 + ((targetIdx - marqueePos.current + MARQUEE_SLOTS) % MARQUEE_SLOTS)
      let stepCount = 0
      const tick = () => {
        marqueePos.current = (marqueePos.current + 1) % MARQUEE_SLOTS
        setHighlight(marqueePos.current)
        stepCount++
        if (stepCount >= total) {
          marqueePhase.current = 'idle'
          done()
          return
        }
        const p = stepCount / total
        const delay = p < 0.45 ? 50 : 50 + Math.pow((p - 0.45) / 0.55, 2) * 260
        marqueeTimer.current = setTimeout(tick, delay)
      }
      marqueeTimer.current = setTimeout(tick, 50)
    },
    [stopMarquee]
  )

  /** 抽奖：先让跑马灯跑起来，拿到服务端结果后减速停在中奖格 */
  const onDraw = () => {
    if (drawing || drawLockRef.current) return
    if (!wheel) {
      Taro.showToast({ title: '转盘还在加载，稍等一下', icon: 'none' })
      return
    }
    if (wheel.balance <= 0) {
      Taro.showToast({ title: '抽奖次数用完了，答完今天的题可获得次数', icon: 'none' })
      return
    }
    if (wheelPrizes.length === 0) {
      Taro.showToast({ title: '奖品还没上架，等等再来', icon: 'none' })
      return
    }
    drawLockRef.current = true
    setDrawing(true)
    setHitIndex(null)
    startMarquee()
    api
      .drawWheel()
      .then((res) => {
        if (!aliveRef.current) {
          drawLockRef.current = false
          return
        }
        const idx = wheelPrizes.findIndex((p) => p.id === res.prize.id)
        // 后台奖品超过 8 个时，超出的奖品没有对应格，统一落回第一格
        const target = idx >= 0 && idx < MARQUEE_SLOTS ? idx : 0
        settleMarquee(target, () => {
          drawLockRef.current = false
          setDrawing(false)
          setHitIndex(target)
          setResult(res)
          setWheel((w) => (w ? { ...w, balance: res.balance } : w))
          api.getPoints().then(setSummary).catch(() => {})
          api.getWheel().then(setWheel).catch(() => {})
        })
      })
      .catch((err) => {
        drawLockRef.current = false
        if (!aliveRef.current) return
        stopMarquee()
        setDrawing(false)
        setHighlight(-1)
        Taro.showToast({ title: err.message || '抽奖失败，请重试', icon: 'none' })
      })
  }

  /** 实物奖品：提交收货信息 */
  const submitContact = () => {
    if (!result || contactBusy) return
    if (!contactName.trim()) {
      Taro.showToast({ title: '请填写收货人', icon: 'none' })
      return
    }
    if (!/^[0-9+\-\s]{6,20}$/.test(contactPhone.trim())) {
      Taro.showToast({ title: '请填写正确的手机号', icon: 'none' })
      return
    }
    if (contactAddress.trim().length < 5) {
      Taro.showToast({ title: '请填写详细收货地址', icon: 'none' })
      return
    }
    setContactBusy(true)
    api
      .setDrawContact({
        drawId: result.drawId,
        name: contactName.trim(),
        phone: contactPhone.trim(),
        address: contactAddress.trim()
      })
      .then(() => {
        Taro.showToast({ title: '收货信息已提交', icon: 'success' })
        setResult((r) => (r ? { ...r, needContact: false } : r))
        setContactName('')
        setContactPhone('')
        setContactAddress('')
        api.getWheel().then(setWheel).catch(() => {})
      })
      .catch((err) => Taro.showToast({ title: err.message || '提交失败', icon: 'none' }))
      .finally(() => setContactBusy(false))
  }

  /** 待填收货的实物中奖：从「我的中奖记录」再次打开表单 */
  const openContact = (d: WheelDraw) => {
    setResult({
      drawId: d.id,
      prize: { id: d.prizeId, name: d.prizeName, type: d.prizeType, value: d.prizeValue },
      balance: drawChances,
      needContact: true,
      message: '请填写收货信息，我们会尽快寄出'
    })
  }

  const drawStatusText = (s: string) =>
    ({
      won: '已中奖',
      pending_contact: '待填收货信息',
      pending_ship: '待发货',
      shipped: '已发货',
      done: '已完成'
    })[s] || s

  // 未登录：不展示积分余额与兑换区，只给登录入口
  if (!loggedIn) {
    return (
      <View className={styles.page}>
        <View className={styles.gateCard}>
          <Text className={styles.gateEmoji}>🔒</Text>
          <Text className={styles.gateTitle}>登录后查看积分</Text>
          <Text className={styles.gateHint}>
            积分、兑换记录和回看券都跟你的微信账号绑定，换设备登录后也还在。
          </Text>
          <View className={styles.gateBtn} onClick={handleLogin}>
            {logging ? '登录中…' : '一键登录'}
          </View>
        </View>
      </View>
    )
  }

  return (
    <View className={styles.page}>
      {/* 余额卡 */}
      <View className={styles.balanceCard}>
        <Text className={styles.balanceNum}>{balance}</Text>
        <View className={styles.balanceMeta}>
          <Text className={styles.metaItem}>累计获得 {summary ? summary.totalEarned : 0}</Text>
          <Text className={styles.metaDivider}>·</Text>
          <Text className={styles.metaItem}>今日已得 {summary ? summary.earnedToday : 0}</Text>
        </View>
        {summary && summary.expiringSoon > 0 && (
          <Text className={styles.expiringTip}>
            ⏳ {summary.expiringSoon} 积分将于 {expireTipDays} 天内过期，记得使用
          </Text>
        )}
        <Text className={styles.balanceRule}>
          答题可得积分与抽奖次数，转盘也能抽到积分；积分仅在本小程序内使用，不可转让、不可提现，有效期 {validDays} 天。
        </Text>
      </View>

      {/* 转盘抽奖 */}
      {wheelEnabled && (
        <>
          <View className={styles.sectionTitle}>转盘抽奖</View>
          <Text className={styles.sectionHint}>
            答完每天一题得 {perAnswer} 次，连答满 7 天额外 {streakBonus} 次；今日已得{' '}
            {wheel ? wheel.earnedToday : 0} 次，单日上限 {config ? config.drawDailyCap : 3} 次。
          </Text>
          <View className={styles.marqueeCard}>
            <View className={styles.marqueeGrid}>
              {GRID_ORDER.map((slotIdx, pos) => {
                // 中心格：抽奖按钮
                if (slotIdx === -1) {
                  return (
                    <View key='marquee-center' className={styles.marqueeCell}>
                      <View
                        className={`${styles.marqueeCenter} ${
                          drawing || drawChances <= 0 ? styles.marqueeCenterDisabled : ''
                        }`}
                        onClick={onDraw}
                      >
                        <Text className={styles.marqueeCenterText}>
                          {drawing ? '抽奖中' : '抽奖'}
                        </Text>
                        <Text className={styles.marqueeCenterSub}>{drawChances} 次</Text>
                      </View>
                    </View>
                  )
                }
                const p = marqueePrizes[slotIdx]
                const cellCls = [
                  styles.marqueeCell,
                  highlight === slotIdx ? styles.marqueeCellActive : '',
                  hitIndex === slotIdx ? styles.marqueeCellHit : ''
                ]
                  .filter(Boolean)
                  .join(' ')
                return (
                  <View key={`${p.id}-${pos}`} className={cellCls}>
                    <View className={styles.marqueeCellInner}>
                      {p.image ? (
                        <>
                          {/* 后台配了奖品图：整格铺满，名称压在底部渐变上 */}
                          <Image
                            className={styles.marqueeCellImg}
                            src={prizeImageSrc(p.image)}
                            mode='aspectFill'
                          />
                          <View className={styles.marqueeCellMask} />
                          <Text className={styles.marqueeCellNameOverlay}>{p.name}</Text>
                        </>
                      ) : (
                        <>
                          <Text className={styles.marqueeCellIcon}>{prizeIcon(p.type)}</Text>
                          <Text className={styles.marqueeCellName}>{p.name}</Text>
                        </>
                      )}
                    </View>
                  </View>
                )
              })}
            </View>
            <Text className={styles.marqueeFoot}>
              还剩 {drawChances} 次
              {drawChances <= 0 ? ' · 答完今天的题可获得次数' : ' · 点中间按钮抽奖'}
            </Text>
          </View>

          {wheel && wheel.draws.length > 0 && (
            <>
              <View className={styles.sectionTitle}>我的中奖记录</View>
              <View className={styles.ledgerCard}>
                {wheel.draws.slice(0, 10).map((d) => (
                  <View key={d.id} className={styles.ledgerRow}>
                    <View className={styles.ledgerInfo}>
                      <Text className={styles.ledgerReason}>{d.prizeName}</Text>
                      <Text className={styles.ledgerTime}>
                        {formatTime(d.createdAt)} · {drawStatusText(d.status)}
                      </Text>
                    </View>
                    {d.prizeType === 'physical' && d.status === 'pending_contact' ? (
                      <Text className={styles.fillContactBtn} onClick={() => openContact(d)}>
                        填收货信息
                      </Text>
                    ) : (
                      <Text className={styles.drawStatusTag}>{drawStatusText(d.status)}</Text>
                    )}
                  </View>
                ))}
              </View>
            </>
          )}
        </>
      )}

      {/* 兑换区 */}
      {prizesEnabled && (
        <>
          <View className={styles.sectionTitle}>积分兑换</View>
          <Text className={styles.sectionHint}>虚拟权益实时发放；每人每品每月 1 次，兑完自动下架，不做限时抢。</Text>
          {prizes.map((p) => {
            const soldOut = p.stock <= 0
            const monthDone = p.redeemedThisMonth >= p.monthlyLimit
            const notEnough = balance < p.cost
            return (
              <View key={p.id} className={styles.prizeCard}>
                {p.image && (
                  <Image
                    className={styles.prizeThumb}
                    src={prizeImageSrc(p.image)}
                    mode='aspectFill'
                    lazyLoad
                  />
                )}
                <View className={styles.prizeInfo}>
                  <Text className={styles.prizeName}>{p.name}</Text>
                  <Text className={styles.prizeDesc}>{p.desc}</Text>
                  <Text className={styles.prizeStock}>
                    {soldOut ? '已被兑光' : `剩余 ${p.stock} 份`} · 每月限 {p.monthlyLimit} 次
                  </Text>
                </View>
                <View className={styles.prizeAction}>
                  <Text className={styles.prizeCost}>{p.cost} 分</Text>
                  <View
                    className={`${styles.redeemBtn} ${
                      soldOut || monthDone || notEnough ? styles.redeemBtnDisabled : ''
                    }`}
                    onClick={() => onRedeem(p)}
                  >
                    {redeemingId === p.id
                      ? '兑换中…'
                      : soldOut
                        ? '已下架'
                        : monthDone
                          ? '本月已兑'
                          : notEnough
                            ? '积分不足'
                            : '兑换'}
                  </View>
                </View>
              </View>
            )
          })}
        </>
      )}

      {/* 流水区 */}
      <View className={styles.sectionTitle}>积分明细</View>
      <View className={styles.ledgerCard}>
        {summary && summary.ledger.length > 0 ? (
          summary.ledger.map((e) => (
            <View key={e.id} className={styles.ledgerRow}>
              <View className={styles.ledgerInfo}>
                <Text className={styles.ledgerReason}>{e.reason}</Text>
                <Text className={styles.ledgerTime}>{formatTime(e.createdAt)}</Text>
              </View>
              <Text className={e.amount >= 0 ? styles.ledgerPlus : styles.ledgerMinus}>
                {e.amount >= 0 ? `+${e.amount}` : e.amount}
              </Text>
            </View>
          ))
        ) : (
          <View className={styles.ledgerEmpty}>
            <Text>还没有积分记录，转盘抽中的积分会记在这里</Text>
          </View>
        )}
      </View>

      <Text className={styles.pageNote}>
        积分由系统发放，流水只增不改；抽奖与兑换记录生成后不可撤销。实物奖品请填写真实收货信息，对记录有疑问可联系我们。
      </Text>

      {/* 抽奖结果 / 实物收货信息 */}
      {result && (
        <View
          className={styles.modalMask}
          onClick={() => {
            if (!result.needContact) setResult(null)
          }}
        >
          <View className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
            <Text className={styles.modalTitle}>
              {result.prize.type === 'none' ? '谢谢参与' : '恭喜中奖'}
            </Text>
            <Text className={styles.modalPrize}>{result.prize.name}</Text>
            <Text className={styles.modalMsg}>{result.message}</Text>
            {result.needContact && (
              <View className={styles.contactForm}>
                <Input
                  className={styles.contactInput}
                  value={contactName}
                  maxlength={30}
                  placeholder='收货人姓名'
                  placeholderClass='input-ph'
                  onInput={(e) => setContactName(e.detail.value)}
                />
                <Input
                  className={styles.contactInput}
                  value={contactPhone}
                  maxlength={20}
                  placeholder='手机号'
                  placeholderClass='input-ph'
                  onInput={(e) => setContactPhone(e.detail.value)}
                />
                <Input
                  className={styles.contactInput}
                  value={contactAddress}
                  maxlength={200}
                  placeholder='详细收货地址'
                  placeholderClass='input-ph'
                  onInput={(e) => setContactAddress(e.detail.value)}
                />
              </View>
            )}
            <View
              className={styles.modalBtn}
              onClick={() => {
                if (result.needContact) submitContact()
                else setResult(null)
              }}
            >
              {result.needContact ? (contactBusy ? '提交中…' : '提交收货信息') : '知道了'}
            </View>
            {result.needContact && (
              <Text className={styles.modalSkip} onClick={() => setResult(null)}>
                稍后再填（可在「我的中奖记录」补填）
              </Text>
            )}
          </View>
        </View>
      )}

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

export default PointsPage
