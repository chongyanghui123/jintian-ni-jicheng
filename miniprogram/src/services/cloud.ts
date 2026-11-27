import Taro from '@tarojs/taro'
import { API_BASE, CLOUD_ENV } from '@/config'

/** 后端 API 服务
 *  本地开发：Node + SQLite（http://localhost:3001，身份 X-User-Id）
 *  部署模式：微信云开发云函数（身份 OPENID），开关见 config.ts 的 CLOUD_ENV
 */

/** 是否走云函数通道（weapp 端 + 已配置环境 ID） */
const USE_CLOUD = !!CLOUD_ENV && process.env.TARO_ENV === 'weapp'

if (USE_CLOUD) {
  // 云开发初始化：import 本模块即完成，页面无需再调用
  ;(Taro as any).cloud.init({ env: CLOUD_ENV, traceUser: true })
}

/** 用户身份：本地生成并持久化（仅本地模式用，服务端按此记账） */
function getUserId(): string {
  let uid = Taro.getStorageSync('user_id') as string
  if (!uid) {
    uid = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
    Taro.setStorageSync('user_id', uid)
  }
  return uid
}

/** 登录态（进程内缓存：openid 稳定，登录成功后本会话不再重复 wx.login） */
let authState: 'wx' | 'local' | null = null

/** 登录 token：写操作凭证（服务端 HMAC 校验，30 天有效） */
export function getAuthToken(): string {
  return (Taro.getStorageSync('user_token') as string) || ''
}

/** wx.login → code → 后端换 openid + token；失败返回 'local'，不缓存失败态（下次仍可重试） */
async function wxLogin(): Promise<'wx' | 'local'> {
  const uid = getUserId()
  try {
    const { code } = await Taro.login()
    const res = await Taro.request({
      url: `${API_BASE}/api/login`,
      method: 'POST',
      data: { code },
      header: { 'X-User-Id': uid }
    })
    const result = res.data as { code: number; data: { userId?: string; token?: string; degraded?: boolean } }
    if (result && result.code === 0 && result.data && !result.data.degraded && result.data.userId) {
      Taro.setStorageSync('user_id', result.data.userId)
      if (result.data.token) Taro.setStorageSync('user_token', result.data.token)
      authState = 'wx'
      return 'wx'
    }
    return 'local' // 后端未配 secret / code 无效：本次降级
  } catch (err) {
    console.error('[auth] 登录失败，沿用本地身份:', err)
    return 'local'
  }
}

/**
 * 登录：weapp 端 wx.login → 后端 code2session 换 openid。
 * 成功才缓存 'wx'；失败只返回 'local'，避免一次网络抖动导致整个会话都登不上。
 */
export async function ensureLogin(): Promise<'wx' | 'local'> {
  if (authState === 'wx') return 'wx'
  if (USE_CLOUD) {
    authState = 'wx' // 云函数用 OPENID 记账，无需显式登录
    return authState
  }
  if (process.env.TARO_ENV !== 'weapp') return 'local' // H5 端无 wx.login
  const uid = getUserId()
  if (!uid.startsWith('u_')) {
    // 已是 openid（登录过）：视为登录态；token 过期时写接口返回 4010，由 callFunction 重新登录
    authState = 'wx'
    return authState
  }
  return wxLogin()
}

/**
 * 是否已登录：weapp 看 storage 里是否已绑定 openid（u_ 前缀为未登录的本地临时身份）。
 * 云模式 OPENID 自动满足；H5 本地开发无登录概念，恒为 true。
 */
export function isLoggedIn(): boolean {
  if (USE_CLOUD || process.env.TARO_ENV !== 'weapp') return true
  const uid = Taro.getStorageSync('user_id') as string
  return !!uid && !uid.startsWith('u_')
}

/** 退出账号：清空本机身份与登录凭证（服务端账本按 openid 保留，下次登录自动恢复） */
export function logout(): void {
  authState = null
  Taro.removeStorageSync('user_id')
  Taro.removeStorageSync('user_token')
}

/** 写接口（无幂等保证或会改变状态）：网络抖动时不自动重试 */
const NON_RETRYABLE = new Set([
  'submitVote', 'addComment', 'deleteComment', 'likeComment', 'submitQuestion',
  'redeemPrize', 'reportContent', 'drawPastQuestion', 'updateProfile', 'uploadAvatar',
  'submitFeedback', 'subscribeNotify', 'drawWheel'
])

/** 统一云函数调用：两个通道的返回结构都是 {code, message, data}，页面层无感知 */
export async function callFunction<T = any>(
  name: string,
  data?: Record<string, any>,
  retried = false
): Promise<T> {
  if (USE_CLOUD) {
    // 部署模式：wx.cloud.callFunction，云函数用 OPENID 记账
    const res = await (Taro as any).cloud.callFunction({ name, data })
    const result = res.result as { code: number; message: string; data: T }
    if (!result || result.code !== 0) {
      console.error(`[Cloud] ${name} failed:`, result?.message)
      throw new Error(result?.message || '请求失败')
    }
    return result.data
  }
  // 本地开发模式：Taro.request 到 Node API，带登录 token 供服务端校验写操作
  const send = () => Taro.request({
    url: `${API_BASE}/api/${name}`,
    method: 'POST',
    data,
    header: { 'X-User-Id': getUserId(), 'X-User-Token': getAuthToken() }
  })
  let res: Awaited<ReturnType<typeof send>>
  try {
    res = await send()
  } catch (err) {
    // 网络抖动：读接口自动重试一次
    if (!retried && !NON_RETRYABLE.has(name)) {
      console.warn(`[API] ${name} 网络失败，重试一次:`, err)
      await new Promise((r) => setTimeout(r, 300))
      return callFunction<T>(name, data, true)
    }
    throw err
  }
  const result = res.data as { code: number; message: string; data: T }
  // 登录态失效：仅当本地已有 token（登录后过期）才自动续期重试，未登录不静默登录
  if (result && result.code === 4010 && !retried && getAuthToken()) {
    console.warn(`[API] ${name} 需要重新登录:`, result.message)
    Taro.removeStorageSync('user_token')
    authState = null
    await wxLogin()
    return callFunction<T>(name, data, true)
  }
  if (result.code !== 0) {
    console.error(`[API] ${name} failed:`, result.message)
    throw new Error(result.message || '请求失败')
  }
  return result.data
}

export function getDatabase() {
  return null
}
