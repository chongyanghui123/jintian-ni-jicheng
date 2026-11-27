import Taro from '@tarojs/taro'
import { api } from '@/services/api'
import { API_BASE } from '@/config'
import defaultShareImage from '@/assets/share-card.jpg'

/** 会话内缓存：首页/结果页会各自调用，避免同一题重复下载 */
const cache = new Map<string, string>()
/** 并发去重：两个页面同时进，只发一次请求/下载 */
const pending = new Map<string, Promise<string>>()

/** 按文件头识别图片格式，决定落盘扩展名（微信按扩展名渲染本地图） */
function detectExt(buf: ArrayBuffer): string {
  const h = new Uint8Array(buf.slice(0, 12))
  if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) return 'png'
  if (h[0] === 0xff && h[1] === 0xd8) return 'jpg'
  if (h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46
    && h[8] === 0x57 && h[9] === 0x45 && h[10] === 0x42 && h[11] === 0x50) return 'webp'
  return 'jpg'
}

async function fetchShareImage(questionId: string): Promise<string> {
  let fullUrl = ''
  try {
    const { url } = await api.getShareImage(questionId)
    if (!url) return defaultShareImage
    fullUrl = /^https?:\/\//.test(url) ? url : `${API_BASE}${url}`
  } catch (err) {
    console.error('[share] 分享图接口失败，用默认图:', err)
    return defaultShareImage
  }

  // 1) downloadFile（需在微信公众平台把域名加入 downloadFile 合法域名）
  try {
    const res = await Taro.downloadFile({ url: fullUrl })
    if (res.statusCode === 200 && res.tempFilePath) return res.tempFilePath
    console.error('[share] downloadFile 状态码异常:', res.statusCode)
  } catch (err) {
    console.error('[share] downloadFile 失败，尝试 request 兜底:', err)
  }

  // 2) request 兜底（走 request 合法域名），写入用户目录后复用
  try {
    const res = await Taro.request<ArrayBuffer>({ url: fullUrl, method: 'GET', responseType: 'arraybuffer' })
    const buf = res.data
    if (res.statusCode === 200 && buf && buf.byteLength > 0) {
      const ext = detectExt(buf)
      const fs = Taro.getFileSystemManager()
      const filePath = `${Taro.env.USER_DATA_PATH}/share-today.${ext}`
      fs.writeFileSync(filePath, buf)
      for (const other of ['png', 'jpg', 'webp']) {
        if (other !== ext) {
          try { fs.unlinkSync(`${Taro.env.USER_DATA_PATH}/share-today.${other}`) } catch { /* 不存在 */ }
        }
      }
      return filePath
    }
    console.error('[share] request 兜底状态码异常:', res.statusCode)
  } catch (err) {
    console.error('[share] request 兜底失败，用默认图:', err)
  }
  return defaultShareImage
}

/**
 * 取当天题目的 AI 分享图，并下载成本地文件（分享 imageUrl 用本地路径最稳）。
 * 先走 downloadFile；失败再走 request + 写文件；仍失败退回内置默认图，保证分享永远有图。
 * 成功结果在会话内缓存（失败不缓存，下次进页面还能重试）。
 */
export function loadShareImage(questionId: string): Promise<string> {
  if (!questionId) return Promise.resolve(defaultShareImage)
  const hit = cache.get(questionId)
  if (hit) return Promise.resolve(hit)
  const task = pending.get(questionId)
  if (task) return task
  const p = fetchShareImage(questionId)
    .then((path) => {
      if (path !== defaultShareImage) cache.set(questionId, path)
      return path
    })
    .finally(() => pending.delete(questionId))
  pending.set(questionId, p)
  return p
}
