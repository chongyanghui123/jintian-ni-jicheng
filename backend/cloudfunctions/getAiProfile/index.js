// 云函数：AI 侧写
// 优先真大模型（智谱 OpenAI 兼容端点），失败/超时/内容不合规一律降级模板库；
// 结果按 用户+题目 当日缓存（集合 ai_cache），次日自动过期。
// 部署配置（云开发控制台 → 云函数 → 环境变量）：
//   AI_API_KEY  智谱 API Key（https://open.bigmodel.cn）；留空则纯模板库，行为同 MVP 版
//   AI_MODEL    模型名，默认 glm-4-flash（免费档）
const https = require('https')
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const AI_API_KEY = process.env.AI_API_KEY || ''
const AI_MODEL = process.env.AI_MODEL || 'glm-4-flash'
const AI_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
const AI_TIMEOUT_MS = 2500

/** 固定标签池（标签不交给模型，保持可控；文档 3.5：不做人格定型） */
const TAGS = {
  'fast-major': '直觉快刀',
  'mid-major': '稳妥站队',
  'slow-major': '反复横跳',
  'fast-minor': '逆行快闪',
  'mid-minor': '清醒少数',
  'slow-minor': '孤勇一根',
  'fast-even': '随心一拍',
  'mid-even': '摇摆权衡',
  'slow-even': '纠结本尊'
}

/** 模板文案池（降级兜底） */
const TEXTS = {
  'fast-major': [
    '你几乎是秒选，说明这类题你早有一套自己的答案。大多数人最后也和你站在了一边，跟着直觉走，这次赌对了。',
    '想都没想就选了，这是刻在习惯里的判断。今天你和大多数人站在同一边，直觉这次没有跑偏。'
  ],
  'mid-major': [
    '你斟酌了一下才落笔，这不是冲动，是权衡后的站队。大多数人最后也选了同一边，你站在了稳稳的多数里。',
    '权衡之后你选了大流。不惊艳，但稳——这类题多数人的直觉和你一致。'
  ],
  'slow-major': [
    '你纠结了很久，反复权衡后还是回到了大多数那边。绕了一圈，你其实早就知道哪个更稳。',
    '犹豫了很久最后随了大流。不是没主见，是你把两边都想过了一遍，才选了更稳的那个。'
  ],
  'fast-minor': [
    '秒选，而且选进了少数派。你的第一反应和大多数人不一样——这种直觉要么很准，要么很有趣。',
    '几乎没有犹豫，你却站到了少数那边。快、而且反骨，这题因你这样的选择才有了看头。'
  ],
  'mid-minor': [
    '权衡之后，你还是选了少数那边。你知道自己在逆行，但你认为对就是对，清醒的少数派。',
    '想了一会儿，还是没跟大流走。你选的不是人少的那边，是你认为对的那边。'
  ],
  'slow-minor': [
    '纠结了很久，最后还是选了少数。挣扎过后依然逆行，这大概是你今天最倔的三十秒。',
    '反复权衡后你还是站了少数。多数的方向你没有看不见，只是不想跟着走。'
  ],
  'fast-even': [
    '秒选，这题你也拿不准吧？其实今天大家都在五五开附近摇摆，你只是先一步把摇摆写成了答案。',
    '想都没想就选了。这题两边势均力敌，你的直觉落在哪边，哪边就多一点。'
  ],
  'mid-even': [
    '权衡了一下才选。这题两边咬得很紧，你的那一票落在哪边，都算关键票。',
    '琢磨了一会儿。今天多数人和你想得差不多，这题注定没有压倒性的答案。'
  ],
  'slow-even': [
    '你纠结了很久，放心，这题人人都纠结。两边几乎打平，你的犹豫一点都不多余。',
    '纠结许久才落选。这种势均力敌的题，慢一点反而是认真的表现。'
  ]
}

const DISCLAIMER = 'AI 生成，图一乐，别当诊断书。'

/** 内容红线：这些词出现即判定 AI 输出不合规，降级模板（文档 3.5 + 项目硬约束） */
const BANNED_RE = /回避型|讨好型|人格|INFP|MBTI|抑郁|焦虑|双相|拖延症|心理(学|问题|疾病)|诊断|建议你|你可以尝试|应该去|需要去|治疗|咨询|复盘你的|反思你的/i
const MAX_BANG = 2 // 感叹号上限，克制

function bandOf(duration) {
  if (duration < 5) return 'fast'
  if (duration <= 20) return 'mid'
  return 'slow'
}

function crowdOf(ratio) {
  if (ratio >= 60) return 'major'
  if (ratio <= 40 && ratio >= 0) return 'minor'
  return 'even'
}

function hashString(s) {
  let seed = 0
  for (let i = 0; i < s.length; i++) seed = (seed * 31 + s.charCodeAt(i)) % 9973
  return seed
}

/** 云函数运行在 UTC，统一 +8h 换算北京时间（口径同 getTodayQuestion） */
function beijingDate(d) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** AI 输出合规校验：长度 + 禁词 + 标点克制；不通过则降级模板 */
function isValidText(text) {
  if (!text || typeof text !== 'string') return false
  const t = text.trim()
  if (t.length < 15 || t.length > 100) return false
  if (BANNED_RE.test(t)) return false
  const bangs = (t.match(/[！!]/g) || []).length
  if (bangs > MAX_BANG) return false
  return true
}

/** 模板降级生成 */
function templateOf(band, questionId, option) {
  const pool = TEXTS[band] || TEXTS['fast-even']
  return pool[hashString(`${questionId}-${option}`) % pool.length]
}

/** https POST（内置模块，云函数无额外依赖） */
function httpsPost(url, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = JSON.stringify(body)
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: Object.assign(
          { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
          headers
        )
      },
      (res) => {
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf))
          } catch (e) {
            reject(new Error('bad json'))
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.write(data)
    req.end()
  })
}

/** 真模型生成侧写文案；标签仍由 band 决定，模型只写正文 */
async function generateByAI({ title, optionA, optionB, option, duration, ratio, total }) {
  const seconds = Math.max(1, Math.round(duration))
  const crowd =
    ratio >= 60
      ? `你站的是多数边（你选的选项目前约 ${ratio}%）`
      : ratio >= 0 && ratio <= 40
        ? `你站的是少数边（你选的选项目前约 ${ratio}%）`
        : '两边票数接近五五开'
  const sample = total >= 10 ? `全站已有 ${total} 人投票` : '样本还很少，别夸张多数少数'

  const prompt = [
    '你是"夜航电台"小程序的侧写文案生成器。用户刚在一道二选一投票题里做出选择，请写一条侧写文案。',
    `题目：${title || '（未提供）'}`,
    `选项A：${optionA || 'A'}；选项B：${optionB || 'B'}`,
    `用户选了：${option}`,
    `他犹豫了 ${seconds} 秒`,
    `${crowd}；${sample}`,
    '',
    '要求：',
    '- 30~60 字，第二人称"你"，口吻克制、带一点幽默，像深夜电台主播',
    '- 只描述他刚才的动作和站队，可以呼应题目内容，但不复述题目',
    '- 禁止：人格定型词（回避型、讨好型、人格、INFP、MBTI）、心理学术语、任何建议（"建议你""你可以"）、医疗或诊断表述',
    '- 感叹号最多 1 个，不要 emoji，不要引号，不要任何前缀说明',
    '- 直接输出文案正文'
  ].join('\n')

  const res = await httpsPost(
    AI_ENDPOINT,
    {
      model: AI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      max_tokens: 120
    },
    { Authorization: `Bearer ${AI_API_KEY}` },
    AI_TIMEOUT_MS
  )
  const content = res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content
  return content ? String(content).trim().replace(/^["'「]|["'」]$/g, '') : null
}

exports.main = async (event) => {
  try {
    const { questionId, option, duration, ratio, title, optionA, optionB, total } = event
    if (!questionId || (option !== 'A' && option !== 'B')) {
      return { code: -1, message: '参数错误', data: null }
    }
    const band = `${bandOf(duration || 0)}-${crowdOf(typeof ratio === 'number' ? ratio : -1)}`
    const tag = TAGS[band] || '随心一拍'
    const { OPENID } = cloud.getWXContext()
    const today = beijingDate(new Date())
    const cacheId = OPENID ? `${OPENID}_${questionId}` : null

    // 1. 当日缓存命中直接返回（含降级结果：同一用户同题当天不再重复请求模型）
    if (cacheId) {
      try {
        const hit = await db.collection('ai_cache').doc(cacheId).get()
        const d = hit.data
        if (d && d.date === today && d.tag && d.text) {
          return { code: 0, message: 'success', data: { tag: d.tag, text: d.text, disclaimer: DISCLAIMER, source: d.source || 'tpl' } }
        }
      } catch (e) {
        // 未命中，继续
      }
    }

    // 2. 尝试真模型；未配置 Key / 超时 / 出错 / 内容不合规 → 降级模板
    let text = null
    let source = 'tpl'
    if (AI_API_KEY) {
      try {
        const ai = await generateByAI({ title, optionA, optionB, option, duration: duration || 0, ratio: typeof ratio === 'number' ? ratio : -1, total: total || 0 })
        if (isValidText(ai)) {
          text = ai
          source = 'ai'
        }
      } catch (e) {
        console.error('[getAiProfile] AI failed, fallback to template:', e.message)
      }
    }
    if (!text) text = templateOf(band, questionId, option)

    // 3. 写当日缓存（失败不影响返回）
    if (cacheId) {
      db.collection('ai_cache')
        .doc(cacheId)
        .set({ data: { tag, text, source, date: today, updatedAt: Date.now() } })
        .catch(() => {})
    }

    return { code: 0, message: 'success', data: { tag, text, disclaimer: DISCLAIMER, source } }
  } catch (err) {
    console.error('[getAiProfile] error:', err)
    return { code: -1, message: err.message || '服务异常', data: null }
  }
}
