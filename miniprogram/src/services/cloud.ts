import Taro from '@tarojs/taro'

/** 后端 API 服务（Node + SQLite，本地开发 http://localhost:3001） */
const BASE_URL = 'http://localhost:3001'

/** 用户身份：本地生成并持久化，替代原 OPENID（服务端按此记账） */
function getUserId(): string {
  let uid = Taro.getStorageSync('user_id') as string
  if (!uid) {
    uid = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
    Taro.setStorageSync('user_id', uid)
  }
  return uid
}

export async function callFunction<T = any>(
  name: string,
  data?: Record<string, any>
): Promise<T> {
  const res = await Taro.request({
    url: `${BASE_URL}/api/${name}`,
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
