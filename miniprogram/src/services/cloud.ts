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

/**
 * 静默登录：weapp 端 wx.login → code → 后端 code2session 换 openid 作为持久身份。
 * - 成功：覆盖 storage 的 user_id 为 openid，返回 'wx'
 * - 后端未配 AppSecret / 调用失败：静默降级，沿用本地 ID，返回 'local'
 * - 云模式身份由云函数 OPENID 自动承载，H5 端无微信登录，直接短路
 */
export async function ensureLogin(): Promise<'wx' | 'local'> {
  if (authState) return authState
  if (USE_CLOUD) {
    authState = 'wx' // 云函数用 OPENID 记账，无需显式登录
    return authState
  }
  const uid = getUserId()
  if (process.env.TARO_ENV !== 'weapp' || !uid.startsWith('u_')) {
    // H5 端无 wx.login；已持 openid 说明登录过
    authState = uid.startsWith('u_') ? 'local' : 'wx'
    return authState
  }
  try {
    const { code } = await Taro.login()
    const res = await Taro.request({
      url: `${API_BASE}/api/login`,
      method: 'POST',
      data: { code },
      header: { 'X-User-Id': uid }
    })
    const result = res.data as { code: number; data: { userId?: string; degraded?: boolean } }
    if (result && result.code === 0 && result.data && !result.data.degraded && result.data.userId) {
      Taro.setStorageSync('user_id', result.data.userId)
      authState = 'wx'
    } else {
      authState = 'local' // 后端未配 secret，静默降级
    }
  } catch (err) {
    console.error('[auth] 静默登录失败，沿用本地身份:', err)
    authState = 'local'
  }
  return authState
}

/** 统一云函数调用：两个通道的返回结构都是 {code, message, data}，页面层无感知 */
export async function callFunction<T = any>(
  name: string,
  data?: Record<string, any>
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
  // 本地开发模式：Taro.request 到本地 Node API
  const res = await Taro.request({
    url: `${API_BASE}/api/${name}`,
    method: 'POST',
    data,
    header: { 'X-User-Id': getUserId() }
  })
  const result = res.data as { code: number; message: string; data: T }
  if (result.code !== 0) {
    console.error(`[API] ${name} failed:`, result.message)
    throw new Error(result.message || '请求失败')
  }
  return result.data
}

export function getDatabase() {
  return null
}
