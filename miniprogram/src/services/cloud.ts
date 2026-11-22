import Taro from '@tarojs/taro'
import { CLOUD_ENV } from '@/config'

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
    url: `http://localhost:3001/api/${name}`,
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
