/**
 * 今天你几成 · 小程序 API 服务（Node + 内置 node:sqlite，零依赖）
 *
 * 与运营后台（backend/admin，Flask + SQLite）共享同一个 SQLite 库文件 admin.db：
 * 题库/排期/投稿审核/举报/短评管理由后台维护，本服务只读题库、写业务数据。
 *
 * 接口：POST /api/<name>，与原微信云函数同名同参同返回结构：
 *   { code: 0, message: 'success', data: ... }
 * 用户身份：请求头 X-User-Id（H5 端本地生成并持久化；替代原 OPENID）。
 *
 * 运行：node backend/api/server.js   （默认端口 3001）
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const PORT = process.env.PORT || 3001
const DB_PATH = path.join(__dirname, '..', 'admin', 'admin.db')
const QUESTIONS_TS = path.join(__dirname, '..', '..', 'miniprogram', 'src', 'data', 'questions.ts')

// ---------- AI 配置（backend/api/config.json；apiKey 为空时自动降级模板文案） ----------
let AI_CONFIG = {
  apiKey: '',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4', // OpenAI 兼容：智谱 / DeepSeek / 豆包等均可
  model: 'glm-4-flash',
  timeoutMs: 8000
}
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'))
  if (cfg.ai) AI_CONFIG = { ...AI_CONFIG, ...cfg.ai, ...(process.env.AI_API_KEY ? { apiKey: process.env.AI_API_KEY } : {}) }
} catch { /* 没有配置文件则用默认 */ }


// ---------- 北京时间口径（文档 11.3）：一切日期以 UTC+8 换算 ----------
function beijingDate(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}
function nowISO() {
  return new Date().toISOString() // UTC ISO，所有 created_at 统一此格式
}
function bjMidnightUTCISO(dayStr) {
  return new Date(`${dayStr}T00:00:00+08:00`).toISOString() // 北京零点对应的 UTC 时刻
}

// ---------- 数据库 ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      optionA TEXT NOT NULL,
      optionB TEXT NOT NULL,
      show_date TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT 'question',
      reason TEXT NOT NULL,
      detail TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      optionA TEXT NOT NULL,
      optionB TEXT NOT NULL,
      signature TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      show_date TEXT,
      reject_reason TEXT,
      notify_text TEXT,
      source TEXT NOT NULL DEFAULT 'import',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL,
      option TEXT NOT NULL,
      content TEXT NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0,
      report_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      question_date TEXT NOT NULL,
      option TEXT NOT NULL CHECK(option IN ('A','B')),
      duration INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_uniq ON votes(user_id, question_id);
    CREATE TABLE IF NOT EXISTS points_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      ref_id TEXT,
      order_no TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_earn_ref
      ON points_ledger(user_id, ref_id) WHERE type='earn' AND ref_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS prizes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      desc TEXT DEFAULT '',
      cost INTEGER NOT NULL,
      stock INTEGER NOT NULL,
      monthly_limit INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS redeem_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      order_no TEXT UNIQUE NOT NULL,
      prize_id TEXT NOT NULL,
      prize_name TEXT,
      cost INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_profiles (
      cache_key TEXT PRIMARY KEY,
      tag TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comment_likes (
      user_id TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, comment_id)
    );
    CREATE TABLE IF NOT EXISTS relook_draws (
      user_id TEXT NOT NULL,
      draw_date TEXT NOT NULL,
      question_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, draw_date)
    );
    CREATE INDEX IF NOT EXISTS idx_questions_show_date ON questions(show_date);
    CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
  `)
  // 兼容升级：comments 缺 likes 列则补上（点赞数直接冗余在短评上，读列表不用聚合）
  const ccols = db.prepare('PRAGMA table_info(comments)').all()
  if (!ccols.some((c) => c.name === 'likes')) {
    db.exec('ALTER TABLE comments ADD COLUMN likes INTEGER NOT NULL DEFAULT 0')
  }
  // 兼容升级：老库缺字段则补上
  const qcols = db.prepare('PRAGMA table_info(questions)').all()
  if (!qcols.some((c) => c.name === 'source')) {
    db.exec("ALTER TABLE questions ADD COLUMN source TEXT NOT NULL DEFAULT 'builtin'")
  }
  for (const [table, col] of [['comments', 'user_id'], ['submissions', 'user_id']]) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all()
    if (!cols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT DEFAULT ''`)
    }
  }
}

// ---------- 种子数据（幂等）：题库导入 + 排期 + 奖品 + 演示短评 ----------
function seed() {
  const qcount = db.prepare('SELECT COUNT(*) c FROM questions').get().c
  if (qcount === 0 && fs.existsSync(QUESTIONS_TS)) {
    const content = fs.readFileSync(QUESTIONS_TS, 'utf-8')
    const re = /id:\s*'([^']+)'.*?title:\s*'([^']+)'.*?optionA:\s*'([^']+)'.*?optionB:\s*'([^']+)'/g
    const ins = db.prepare(
      "INSERT OR IGNORE INTO questions (id, title, optionA, optionB, status) VALUES (?,?,?,?, 'draft')")
    let n = 0
    for (const m of content.matchAll(re)) {
      ins.run(m[1], m[2], m[3], m[4])
      n++
    }
    console.log(`[seed] 已导入 ${n} 道内置题（draft）`)
  }

  // 排期：昨天 ~ 未来 6 天，每天一道已发布题（空档才填；用户投稿优先于内置题）
  const drafts = db.prepare(
    "SELECT id FROM questions WHERE status='draft' AND (show_date IS NULL OR show_date='') "
    + "ORDER BY (source='miniprogram') DESC, id"
  ).all().map((r) => r.id)
  const setSchedule = db.prepare("UPDATE questions SET show_date=?, status='published' WHERE id=?")
  let di = 0
  for (let off = -1; off <= 6; off++) {
    const d = beijingDate(new Date(Date.now() + off * 24 * 3600 * 1000))
    const hit = db.prepare("SELECT 1 FROM questions WHERE show_date=? AND status='published'").get(d)
    if (!hit && di < drafts.length) setSchedule.run(d, drafts[di++])
  }
  if (di > 0) console.log(`[seed] 已排期 ${di} 天（含昨日，便于「往期揭晓」演示）`)

  const pcount = db.prepare('SELECT COUNT(*) c FROM prizes').get().c
  if (pcount === 0) {
    const ins = db.prepare('INSERT INTO prizes (id, name, desc, cost, stock, monthly_limit) VALUES (?,?,?,?,?,?)')
    ins.run('p_title', '专属称号「清醒人」', '展示在「我的」页面，仅答过题的人能懂', 100, 100, 1)
    ins.run('p_relook', '往期回看券', '解锁一道往期题的完整结果与占比', 200, 50, 1)
    ins.run('p_skin', '限定皮肤「夜航」', '结果页专属配色，30 天', 300, 20, 1)
    console.log('[seed] 已写入 3 个兑换商品')
  }

  const ccount = db.prepare('SELECT COUNT(*) c FROM comments').get().c
  if (ccount === 0) {
    const todayQ = db.prepare(
      "SELECT id FROM questions WHERE show_date=? AND status='published'").get(beijingDate())
    if (todayQ) {
      const ins = db.prepare(
        "INSERT INTO comments (id, question_id, option, content, hidden, report_count, user_id, created_at) VALUES (?,?,?,?,?,?,?,?)")
      ins.run('cdemo1', todayQ.id, 'A', '先吃饭，饿着肚子谈什么都不诚实', 0, 0, '', nowISO())
      ins.run('cdemo2', todayQ.id, 'B', '事情压在心里会发酵，拖到最后更难开口', 0, 0, '', nowISO())
      console.log('[seed] 已写入 2 条演示短评')
    }
  }
}

// ---------- 业务实现（与云函数同口径） ----------
const POINTS_ANSWER = 2
const POINTS_STREAK7 = 10
const DAILY_CAP = 60
const BLOCK_WORDS_COMMENT = ['加微信', '加v', '转账', '赌博', '裸', '约炮', '代购', '兼职']
const BLOCK_WORDS_SUBMIT = ['加微信', '加v', '转账', '赌博', '裸', '约炮', '官方', '客服', '管理员']
const SUBMIT_DAILY_LIMIT = 3
const VALID_REASONS = ['low_quality', 'inappropriate', 'violation', 'other']

const mapQuestion = (q) => q && ({
  id: q.id, title: q.title, optionA: q.optionA, optionB: q.optionB, date: q.show_date || ''
})

function countVotes(questionId) {
  const a = db.prepare("SELECT COUNT(*) c FROM votes WHERE question_id=? AND option='A'").get(questionId).c
  const b = db.prepare("SELECT COUNT(*) c FROM votes WHERE question_id=? AND option='B'").get(questionId).c
  return { votesA: a, votesB: b, total: a + b }
}

function earnedTodaySum(userId, today) {
  const start = bjMidnightUTCISO(today)
  const row = db.prepare(
    "SELECT COALESCE(SUM(amount),0) s FROM points_ledger WHERE user_id=? AND type='earn' AND created_at>=?"
  ).get(userId, start)
  return row.s
}

function earnPoints(userId, amount, reason, refId, today) {
  if (earnedTodaySum(userId, today) + amount > DAILY_CAP) return false
  const exist = db.prepare(
    "SELECT 1 FROM points_ledger WHERE user_id=? AND type='earn' AND ref_id=?").get(userId, refId)
  if (exist) return false
  db.prepare(
    'INSERT INTO points_ledger (user_id, type, amount, reason, ref_id, created_at) VALUES (?,?,?,?,?,?)'
  ).run(userId, 'earn', amount, reason, refId, nowISO())
  return true
}

function streakIncludingToday(userId, today) {
  const rows = db.prepare('SELECT DISTINCT question_date FROM votes WHERE user_id=?').all(userId)
  const dates = new Set(rows.map((r) => r.question_date))
  let streak = 1
  let cursor = 1
  for (;;) {
    const ds = beijingDate(new Date(new Date(`${today}T00:00:00+08:00`).getTime() - cursor * 86400000))
    if (!dates.has(ds)) break
    streak++
    cursor++
  }
  return streak
}

function balanceOf(userId) {
  const expiresBefore = new Date(Date.now() - 365 * 86400000).toISOString() // 积分 12 个月有效
  const row = db.prepare(
    'SELECT COALESCE(SUM(amount),0) s FROM points_ledger WHERE user_id=? AND created_at>=?'
  ).get(userId, expiresBefore)
  return row.s
}

function ledgerOf(userId, limit = 20) {
  const expiresBefore = new Date(Date.now() - 365 * 86400000).toISOString()
  return db.prepare(
    'SELECT * FROM points_ledger WHERE user_id=? AND created_at>=? ORDER BY created_at DESC LIMIT ?'
  ).all(userId, expiresBefore, limit).map((e) => ({
    id: String(e.id), type: e.type, amount: e.amount, reason: e.reason,
    refId: e.ref_id || undefined, orderNo: e.order_no || undefined, createdAt: e.created_at
  }))
}

/** 通用 AI 对话调用（OpenAI 兼容协议）：成功返回文本，失败/超时抛错由调用方降级 */
async function callAiChat(prompt, maxTokens = 200) {
  if (!AI_CONFIG.apiKey) throw new Error('未配置 AI Key')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), AI_CONFIG.timeoutMs || 8000)
  try {
    const res = await fetch(`${AI_CONFIG.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_CONFIG.apiKey}`
      },
      body: JSON.stringify({
        model: AI_CONFIG.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.9,
        max_tokens: maxTokens,
        stream: false
      }),
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`AI HTTP ${res.status}`)
    const data = await res.json()
    const text = data.choices && data.choices[0] && data.choices[0].message
      ? String(data.choices[0].message.content || '').trim().replace(/^["'「]|["'」]$/g, '')
      : ''
    if (!text || text.length < 10) throw new Error('AI 返回内容为空')
    console.log(`[ai] ${AI_CONFIG.model} 生成成功 ${text.length} 字`)
    return text.slice(0, 200)
  } finally {
    clearTimeout(timer)
  }
}

/** AI 侧写文案：真实调用 + 失败降级模板 */
async function aiGenerateText({ args, key, tag, fallbackText }) {
  if (!AI_CONFIG.apiKey) return fallbackText
  const q = db.prepare('SELECT * FROM questions WHERE id=?').get(args.questionId)
  const optionText = q ? (args.option === 'A' ? q.optionA : q.optionB) : ''
  const ratio = typeof args.ratio === 'number' ? args.ratio : -1
  const pct = ratio >= 0 ? Math.round(ratio) : null
  const prompt = [
    `## 你的人设`,
    `你是「夜航电台」的主理人，代号"老航"。每晚零点，你守着一档叫「今天你几成」的栏目,`,
    `看千万个网友为同一道两难题纠结、站队。你像一个通透但不油腻的老朋友：`,
    `见过太多深夜的摇摆，所以不轻易评判别人；说话简短、有画面感、偶尔冷幽默，`,
    `擅长用一个具体的小场景把人的选择说透，结尾常常留一点余味，不说教。`,
    ``,
    `## 今晚这位听众`,
    `题目：《${q ? q.title : ''}》，他选了「${optionText}」，决策用时 ${args.duration || 0} 秒，`,
    pct === null ? `占比未知。` : `目前有 ${pct}% 的人和他选了同一边。`,
    `他的风格标签是「${tag}」（${key}）。`,
    ``,
    `## 今晚你对他说的话`,
    `- 30~60 个字，用第二人称"你"，像电台里轻声说的那句晚安点评`,
    `- 可以点一下他的用时、占比或标签，但别像报数据，要像唠嗑`,
    `- 不做人格定型（禁用"回避型""讨好型"等心理学标签词），不给建议，不评判对错`,
    `- 只输出这段话本身：不要引号、不要解释、不要署名`
  ].join('\n')
  try {
    return await callAiChat(prompt)
  } catch (e) {
    console.error('[ai] 调用失败，降级模板:', e.message)
    return fallbackText
  }
}

const handlers = {
  getTodayQuestion(args, userId) {
    const today = beijingDate()
    const q = db.prepare(
      "SELECT * FROM questions WHERE show_date=? AND status='published' LIMIT 1").get(today)
    let answered = false, myOption = null, myDuration = 0
    if (q) {
      const v = db.prepare(
        'SELECT * FROM votes WHERE user_id=? AND question_id=?').get(userId, q.id)
      if (v) { answered = true; myOption = v.option; myDuration = v.duration }
    }
    return { serverDate: today, question: mapQuestion(q), answered, myOption, myDuration }
  },

  submitVote(args, userId) {
    const { questionId, option } = args
    const duration = Math.min(60, Math.max(0, Math.round(args.duration || 0)))
    if (!questionId || (option !== 'A' && option !== 'B')) throw new Error('参数错误')
    const today = beijingDate()
    const q = db.prepare('SELECT * FROM questions WHERE id=?').get(questionId)
    if (!q || q.status !== 'published') throw new Error('题目不存在或已下架')
    if (q.show_date !== today) throw new Error('今天已经换题了') // 跨零点保护

    const exist = db.prepare('SELECT * FROM votes WHERE user_id=? AND question_id=?').get(userId, questionId)
    if (exist) return { ...countVotes(questionId), myOption: exist.option } // 幂等

    db.prepare(
      'INSERT INTO votes (user_id, question_id, question_date, option, duration, created_at) VALUES (?,?,?,?,?,?)'
    ).run(userId, questionId, q.show_date, option, duration, nowISO())

    // 积分发放（服务端发放，幂等；失败不影响投票）
    let earnedPoints = 0, earnedReason
    try {
      if (earnPoints(userId, POINTS_ANSWER, '每日答题', questionId, today)) {
        earnedPoints += POINTS_ANSWER
        earnedReason = '每日答题'
      }
      const streak = streakIncludingToday(userId, today)
      if (streak > 0 && streak % 7 === 0) {
        const cycleStart = beijingDate(new Date(
          new Date(`${today}T00:00:00+08:00`).getTime() - (streak - 1) * 86400000))
        if (earnPoints(userId, POINTS_STREAK7, '连续答题 7 天奖励', `streak7-${cycleStart}`, today)) {
          earnedPoints += POINTS_STREAK7
          earnedReason = earnedReason ? `${earnedReason} + 连答 7 天奖励` : '连答 7 天奖励'
        }
      }
    } catch (e) { console.error('[submitVote] earnPoints failed:', e.message) }

    return { ...countVotes(questionId), myOption: option, earnedPoints, earnedReason }
  },

  getVoteResult(args, userId) {
    const { questionId } = args
    if (!questionId) throw new Error('缺少题目 ID')
    const q = db.prepare('SELECT * FROM questions WHERE id=?').get(questionId)
    if (!q || q.status !== 'published') throw new Error('题目不存在或已下架')
    const stats = countVotes(questionId)
    const v = db.prepare('SELECT option FROM votes WHERE user_id=? AND question_id=?').get(userId, questionId)
    return {
      question: mapQuestion(q), votesA: stats.votesA, votesB: stats.votesB,
      total: stats.total, myOption: v ? v.option : null, isExpired: q.show_date !== beijingDate()
    }
  },

  async getAiProfile(args, userId) {
    const { questionId, option } = args
    if (!questionId || (option !== 'A' && option !== 'B')) throw new Error('参数错误')
    const duration = args.duration || 0
    const ratio = typeof args.ratio === 'number' ? args.ratio : -1
    const band = duration < 5 ? 'fast' : duration <= 20 ? 'mid' : 'slow'
    const crowd = ratio >= 60 ? 'major' : (ratio >= 0 && ratio <= 40) ? 'minor' : 'even'
    const key = `${band}-${crowd}`
    const TAGS = {
      'fast-major': '直觉快刀', 'mid-major': '稳妥站队', 'slow-major': '反复横跳',
      'fast-minor': '逆行快闪', 'mid-minor': '清醒少数', 'slow-minor': '孤勇一根',
      'fast-even': '随心一拍', 'mid-even': '摇摆权衡', 'slow-even': '纠结本尊'
    }
    const TEXTS = {
      'fast-major': ['你几乎是秒选，说明这类题你早有一套自己的答案。大多数人最后也和你站在了一边，跟着直觉走，这次赌对了。',
        '想都没想就选了，这是刻在习惯里的判断。今天你和大多数人站在同一边，直觉这次没有跑偏。'],
      'mid-major': ['你斟酌了一下才落笔，这不是冲动，是权衡后的站队。大多数人最后也选了同一边，你站在了稳稳的多数里。',
        '权衡之后你选了大流。不惊艳，但稳——这类题多数人的直觉和你一致。'],
      'slow-major': ['你纠结了很久，反复权衡后还是回到了大多数那边。绕了一圈，你其实早就知道哪个更稳。',
        '犹豫了很久最后随了大流。不是没主见，是你把两边都想过了一遍，才选了更稳的那个。'],
      'fast-minor': ['秒选，而且选进了少数派。你的第一反应和大多数人不一样——这种直觉要么很准，要么很有趣。',
        '几乎没有犹豫，你却站到了少数那边。快、而且反骨，这题因你这样的选择才有了看头。'],
      'mid-minor': ['权衡之后，你还是选了少数那边。你知道自己在逆行，但你认为对就是对，清醒的少数派。',
        '想了一会儿，还是没跟大流走。你选的不是人少的那边，是你认为对的那边。'],
      'slow-minor': ['纠结了很久，最后还是选了少数。挣扎过后依然逆行，这大概是你今天最倔的三十秒。',
        '反复权衡后你还是站了少数。多数的方向你没有看不见，只是不想跟着走。'],
      'fast-even': ['秒选，这题你也拿不准吧？其实今天大家都在五五开附近摇摆，你只是先一步把摇摆写成了答案。',
        '想都没想就选了。这题两边势均力敌，你的直觉落在哪边，哪边就多一点。'],
      'mid-even': ['权衡了一下才选。这题两边咬得很紧，你的那一票落在哪边，都算关键票。',
        '琢磨了一会儿。今天多数人和你想得差不多，这题注定没有压倒性的答案。'],
      'slow-even': ['你纠结了很久，放心，这题人人都纠结。两边几乎打平，你的犹豫一点都不多余。',
        '纠结许久才落选。这种势均力敌的题，慢一点反而是认真的表现。']
    }
    let seed = 0
    for (const ch of `${questionId}-${option}`) seed = (seed * 31 + ch.charCodeAt(0)) % 9973
    const pool = TEXTS[key] || TEXTS['fast-even']
    const tag = TAGS[key] || '随心一拍'
    const fallbackText = pool[seed % pool.length]

    // 缓存：每人每题每风格只生成一次——文案是专属的，但当天重进/回看不变
    // （题目每日更换，questionId 变了自然换新文案）
    const cacheKey = `${userId}-${questionId}-${option}-${key}`
    const cached = db.prepare('SELECT text FROM ai_profiles WHERE cache_key=?').get(cacheKey)
    if (cached) return { tag, text: cached.text, disclaimer: 'AI 生成，图一乐，别当诊断书。' }

    // 真实 AI 调用（OpenAI 兼容协议）；失败/超时/未配 Key 降级模板，边界遵守文档 3.5
    const text = await aiGenerateText({ args, key, tag, fallbackText })
    if (text !== fallbackText) {
      db.prepare(
        'INSERT OR IGNORE INTO ai_profiles (cache_key, tag, text, created_at) VALUES (?,?,?,?)'
      ).run(cacheKey, tag, text, nowISO())
    }
    return { tag, text, disclaimer: 'AI 生成，图一乐，别当诊断书。' }
  },

  getYesterdayResult(args, userId) {
    const yesterday = beijingDate(new Date(Date.now() - 86400000))
    const q = db.prepare(
      "SELECT * FROM questions WHERE show_date=? AND status='published' LIMIT 1").get(yesterday)
    if (!q) return null
    const stats = countVotes(q.id)
    const v = db.prepare('SELECT option FROM votes WHERE user_id=? AND question_id=?').get(userId, q.id)
    return {
      date: yesterday, question: mapQuestion(q), votesA: stats.votesA, votesB: stats.votesB,
      total: stats.total, myOption: v ? v.option : null
    }
  },

  reportContent(args) {
    const { targetType, targetId, reason, detail } = args
    if (!targetId || !VALID_REASONS.includes(reason)) throw new Error('参数错误')
    db.prepare(
      'INSERT INTO reports (target_id, target_type, reason, detail, status) VALUES (?,?,?,?,?)'
    ).run(targetId, targetType === 'comment' ? 'comment' : 'question', reason, (detail || '').slice(0, 40), 'open')
    if (targetType === 'comment') {
      const c = db.prepare('SELECT * FROM comments WHERE id=?').get(targetId)
      if (c) {
        const count = (c.report_count || 0) + 1
        const hidden = count >= 3 ? 1 : c.hidden // 3 次举报自动隐藏
        db.prepare('UPDATE comments SET report_count=?, hidden=? WHERE id=?').run(count, hidden, targetId)
      }
    }
    return { ok: true }
  },

  getPoints(args, userId) {
    const today = beijingDate()
    const start = bjMidnightUTCISO(today)
    const todayRow = db.prepare(
      "SELECT COALESCE(SUM(amount),0) s FROM points_ledger WHERE user_id=? AND type='earn' AND amount>0 AND created_at>=?"
    ).get(userId, start)
    const expiresBefore = new Date(Date.now() - 365 * 86400000).toISOString()
    const totalRow = db.prepare(
      "SELECT COALESCE(SUM(amount),0) s FROM points_ledger WHERE user_id=? AND amount>0 AND created_at>=?"
    ).get(userId, expiresBefore)
    const titles = db.prepare(
      "SELECT prize_name FROM redeem_orders WHERE user_id=? AND prize_id='p_title' AND status='done'"
    ).all(userId).map((r) => r.prize_name)
    // 即将过期提醒：90 天内到期（获得于 275~365 天前）的正积分
    const expStart = new Date(Date.now() - 365 * 86400000).toISOString()
    const expCutoff = new Date(Date.now() - 275 * 86400000).toISOString()
    const expiringSoon = db.prepare(
      'SELECT COALESCE(SUM(amount),0) s FROM points_ledger WHERE user_id=? AND amount>0 '
      + 'AND created_at>=? AND created_at<?'
    ).get(userId, expStart, expCutoff).s
    // 限定皮肤「夜航」：p_skin 兑换完成起 30 天有效，过期自动失效
    const skinOrder = db.prepare(
      "SELECT created_at FROM redeem_orders WHERE user_id=? AND prize_id='p_skin' AND status='done' "
      + 'ORDER BY created_at DESC LIMIT 1'
    ).get(userId)
    let skin = null
    if (skinOrder) {
      const expiresAt = new Date(new Date(skinOrder.created_at).getTime() + 30 * 86400000).toISOString()
      if (new Date(expiresAt).getTime() > Date.now()) {
        skin = { id: 'p_skin', name: '夜航', active: true, expiresAt }
      }
    }
    return {
      balance: balanceOf(userId), totalEarned: totalRow.s, earnedToday: todayRow.s,
      expiringSoon, titles, skin, ledger: ledgerOf(userId)
    }
  },

  getPrizes(args, userId) {
    const month = new Date().toISOString().slice(0, 7)
    const defs = db.prepare('SELECT * FROM prizes ORDER BY cost').all()
    const used = db.prepare(
      "SELECT prize_id, COUNT(*) c FROM redeem_orders WHERE status='done' GROUP BY prize_id").all()
    const usedMap = Object.fromEntries(used.map((r) => [r.prize_id, r.c]))
    const myMonth = db.prepare(
      "SELECT prize_id, COUNT(*) c FROM redeem_orders WHERE user_id=? AND status='done' AND created_at>=? GROUP BY prize_id"
    ).all(userId, `${month}-01T00:00:00.000Z`)
    const myMap = Object.fromEntries(myMonth.map((r) => [r.prize_id, r.c]))
    return defs.map((p) => ({
      id: p.id, name: p.name, desc: p.desc, cost: p.cost,
      stock: Math.max(0, p.stock - (usedMap[p.id] || 0)),
      monthlyLimit: p.monthly_limit, redeemedThisMonth: myMap[p.id] || 0
    }))
  },

  redeemPrize(args, userId) {
    const prizeId = args.prizeId
    const p = db.prepare('SELECT * FROM prizes WHERE id=?').get(prizeId)
    if (!p) throw new Error('商品不存在')

    const used = db.prepare(
      "SELECT COUNT(*) c FROM redeem_orders WHERE prize_id=? AND status='done'").get(prizeId).c
    if (used >= p.stock) throw new Error('已被兑光了，下次早点来') // 0 库存自动下架

    const month = new Date().toISOString().slice(0, 7)
    const monthCount = db.prepare(
      "SELECT COUNT(*) c FROM redeem_orders WHERE user_id=? AND prize_id=? AND status='done' AND created_at>=?"
    ).get(userId, prizeId, `${month}-01T00:00:00.000Z`).c
    if (monthCount >= p.monthly_limit) throw new Error('这个奖品本月你已经兑过了，下个月再来')

    const balance = balanceOf(userId)
    if (balance < p.cost) throw new Error(`积分不够，还差 ${p.cost - balance} 分`)

    const orderNo = `R${Date.now()}${Math.floor(Math.random() * 900 + 100)}`
    db.prepare(
      "INSERT INTO redeem_orders (user_id, order_no, prize_id, prize_name, cost, status, created_at) VALUES (?,?,?,?,?, 'pending', ?)"
    ).run(userId, orderNo, prizeId, p.name, p.cost, nowISO())
    try {
      db.exec('BEGIN') // 原子段：扣分 → 完成；失败退单不产生半单
      db.prepare(
        "INSERT INTO points_ledger (user_id, type, amount, reason, order_no, created_at) VALUES (?,?,?,?,?,?)"
      ).run(userId, 'redeem', -p.cost, `兑换 ${p.name}`, orderNo, nowISO())
      db.prepare("UPDATE redeem_orders SET status='done' WHERE order_no=?").run(orderNo)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      db.prepare("UPDATE redeem_orders SET status='refunded' WHERE order_no=?").run(orderNo)
      throw new Error('兑换失败，请重试')
    }
    return { orderNo, prizeName: p.name, balance: balance - p.cost }
  },

  getComments(args, userId) {
    const { questionId } = args
    if (!questionId) throw new Error('参数错误')
    const offset = Math.max(0, Math.round(args.offset || 0))
    const per = 20
    const v = db.prepare('SELECT option FROM votes WHERE user_id=? AND question_id=?').get(userId, questionId)
    if (!v) return { locked: true, comments: [], mine: null, total: 0, hasMore: false } // 服务端门禁
    const myOpt = v.option
    const total = db.prepare(
      'SELECT COUNT(*) c FROM comments WHERE question_id=? AND hidden=0').get(questionId).c
    // 对面立场置顶，其余按点赞数、时间正序；分页用 offset
    const rows = db.prepare(
      'SELECT c.*, (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id=c.id) AS likeCount, '
      + 'EXISTS(SELECT 1 FROM comment_likes cl2 WHERE cl2.comment_id=c.id AND cl2.user_id=?) AS likedByMe '
      + 'FROM comments c WHERE c.question_id=? AND c.hidden=0 '
      + 'ORDER BY (c.option != ?) DESC, likeCount DESC, c.created_at ASC LIMIT ? OFFSET ?'
    ).all(userId, questionId, myOpt, per, offset)
    const mine = db.prepare(
      'SELECT * FROM comments WHERE question_id=? AND user_id=? AND hidden=0').get(questionId, userId)
    const comments = rows.map((c, i) => ({
      id: c.id, questionId: c.question_id, option: c.option, content: c.content,
      isMine: c.user_id === userId, createdAt: c.created_at,
      likes: c.likeCount || 0, isLiked: !!c.likedByMe,
      isOppositeTop: offset === 0 && i === 0 && c.option !== myOpt
    }))
    return {
      locked: false, comments,
      mine: mine ? { id: mine.id, questionId: mine.question_id, option: mine.option,
                     content: mine.content, isMine: true, createdAt: mine.created_at } : null,
      total, hasMore: offset + rows.length < total
    }
  },

  addComment(args, userId) {
    const { questionId, option } = args
    const content = (args.content || '').trim()
    if (!questionId || (option !== 'A' && option !== 'B') || !content) throw new Error('参数错误')
    if (content.length > 40) throw new Error('最多 40 字')
    const lower = content.toLowerCase()
    if (BLOCK_WORDS_COMMENT.some((w) => lower.includes(w))) throw new Error('内容含违规词，改一下再发')
    const v = db.prepare('SELECT 1 FROM votes WHERE user_id=? AND question_id=?').get(userId, questionId)
    if (!v) throw new Error('答完今天这题才能写短评') // 门禁
    const exist = db.prepare(
      'SELECT 1 FROM comments WHERE user_id=? AND question_id=? AND hidden=0').get(userId, questionId)
    if (exist) throw new Error('每题只能写一条短评')
    const id = `c${Date.now()}${Math.floor(Math.random() * 900 + 100)}`
    const createdAt = nowISO()
    db.prepare(
      'INSERT INTO comments (id, question_id, option, content, hidden, report_count, user_id, created_at) VALUES (?,?,?,?,0,0,?,?)'
    ).run(id, questionId, option, content, userId, createdAt)
    return { id, questionId, option, content, isMine: true, createdAt }
  },

  deleteComment(args, userId) {
    const { commentId } = args
    if (!commentId) throw new Error('参数错误')
    const c = db.prepare('SELECT * FROM comments WHERE id=?').get(commentId)
    if (!c || c.user_id !== userId) throw new Error('只能撤回自己的短评')
    if (Date.now() - new Date(c.created_at).getTime() > 5 * 60000) {
      throw new Error('已超过 5 分钟，不能删除了')
    }
    db.prepare('DELETE FROM comments WHERE id=?').run(commentId)
    return { ok: true }
  },

  /** 短评点赞：幂等 toggle（已赞则取消），返回最新点赞数 */
  likeComment(args, userId) {
    const commentId = args.commentId
    if (!commentId) throw new Error('参数错误')
    const c = db.prepare('SELECT * FROM comments WHERE id=? AND hidden=0').get(commentId)
    if (!c) throw new Error('短评不存在或已隐藏')
    const liked = db.prepare(
      'SELECT 1 FROM comment_likes WHERE user_id=? AND comment_id=?').get(userId, commentId)
    if (liked) {
      db.prepare('DELETE FROM comment_likes WHERE user_id=? AND comment_id=?').run(userId, commentId)
      db.prepare('UPDATE comments SET likes = MAX(0, likes - 1) WHERE id=?').run(commentId)
    } else {
      db.prepare(
        'INSERT OR IGNORE INTO comment_likes (user_id, comment_id, created_at) VALUES (?,?,?)'
      ).run(userId, commentId, nowISO())
      db.prepare('UPDATE comments SET likes = likes + 1 WHERE id=?').run(commentId)
    }
    const likes = db.prepare('SELECT likes FROM comments WHERE id=?').get(commentId).likes
    return { commentId, liked: !liked, likes }
  },

  submitQuestion(args, userId) {
    const title = (args.title || '').trim()
    const optionA = (args.optionA || '').trim()
    const optionB = (args.optionB || '').trim()
    const signature = (args.signature || '').trim()
    if (title.length < 4 || title.length > 40) throw new Error('题干需 4~40 字')
    if (optionA.length < 1 || optionA.length > 16) throw new Error('选项 A 需 1~16 字')
    if (optionB.length < 1 || optionB.length > 16) throw new Error('选项 B 需 1~16 字')
    if (optionA === optionB) throw new Error('两个选项不能实质相同')
    if (signature && (signature.length < 2 || signature.length > 8)) throw new Error('署名需 2~8 字')
    if (BLOCK_WORDS_SUBMIT.some((w) => (title + optionA + optionB + signature).includes(w))) {
      throw new Error('内容含违规词，改一下再投')
    }
    const start = bjMidnightUTCISO(beijingDate())
    const todayCount = db.prepare(
      "SELECT COUNT(*) c FROM submissions WHERE user_id=? AND created_at>=?").get(userId, start).c
    if (todayCount >= SUBMIT_DAILY_LIMIT) throw new Error('今天已经投了 3 道，明天再来')
    const id = `s${Date.now()}${Math.floor(Math.random() * 900 + 100)}`
    db.prepare(
      "INSERT INTO submissions (id, title, optionA, optionB, signature, status, source, user_id, created_at) VALUES (?,?,?,?,?, 'pending', 'miniprogram', ?, ?)"
    ).run(id, title, optionA, optionB, signature, userId, nowISO())
    return { id, title, optionA, optionB, signature, status: 'pending', createdAt: nowISO() }
  },

  getMySubmissions(args, userId) {
    return db.prepare(
      'SELECT * FROM submissions WHERE user_id=? ORDER BY created_at DESC LIMIT 50'
    ).all(userId).map((s) => ({
      id: s.id, title: s.title, optionA: s.optionA, optionB: s.optionB,
      signature: s.signature, status: s.status, showDate: s.show_date,
      rejectReason: s.reject_reason, notifyText: s.notify_text, createdAt: s.created_at
    }))
  },

  /** 我的答题历史（服务端为准，换设备不丢） */
  getMyHistory(args, userId) {
    const rows = db.prepare(
      'SELECT v.question_id, v.question_date, v.option, q.title, q.optionA, q.optionB '
      + 'FROM votes v JOIN questions q ON q.id = v.question_id '
      + 'WHERE v.user_id=? ORDER BY v.question_date DESC, v.created_at DESC LIMIT 90'
    ).all(userId)
    const records = rows.map((r) => {
      const stats = countVotes(r.question_id)
      const mineVotes = r.option === 'A' ? stats.votesA : stats.votesB
      return {
        questionId: r.question_id, date: r.question_date, title: r.title,
        optionA: r.optionA, optionB: r.optionB, myOption: r.option,
        votesA: stats.votesA, votesB: stats.votesB, total: stats.total,
        isMinority: stats.total >= 30 && stats.total > 0 && mineVotes / stats.total <= 0.4
      }
    })
    // 回看券状态：是否持券 + 今天是否已抽过（券 30 天有效口径见 drawPastQuestion）
    const hasTicket = !!db.prepare(
      "SELECT 1 FROM redeem_orders WHERE user_id=? AND prize_id='p_relook' AND status='done' LIMIT 1"
    ).get(userId)
    const drawnToday = !!db.prepare(
      'SELECT 1 FROM relook_draws WHERE user_id=? AND draw_date=?').get(userId, beijingDate())
    return { records, relook: { hasTicket, drawnToday } }
  },

  /** 往期回看券：随机抽一道已上墙的往期题（含完整占比；未投过也能看）；每张券每天限抽 1 次 */
  drawPastQuestion(args, userId) {
    const ticket = db.prepare(
      "SELECT 1 FROM redeem_orders WHERE user_id=? AND prize_id='p_relook' AND status='done' LIMIT 1"
    ).get(userId)
    if (!ticket) throw new Error('需要「往期回看券」，去积分页兑换一张')
    const today = beijingDate()
    const drawn = db.prepare(
      'SELECT 1 FROM relook_draws WHERE user_id=? AND draw_date=?').get(userId, today)
    if (drawn) throw new Error('今天已经回看过一道题了，明天再来')
    const excludeId = args.excludeId || ''
    const q = db.prepare(
      "SELECT * FROM questions WHERE status='published' AND show_date IS NOT NULL "
      + 'AND show_date < ? AND id != ? ORDER BY RANDOM() LIMIT 1'
    ).get(today, excludeId)
    if (!q) return null
    db.prepare(
      'INSERT OR IGNORE INTO relook_draws (user_id, draw_date, question_id, created_at) VALUES (?,?,?,?)'
    ).run(userId, today, q.id, nowISO())
    const stats = countVotes(q.id)
    const v = db.prepare('SELECT option FROM votes WHERE user_id=? AND question_id=?').get(userId, q.id)
    return {
      question: mapQuestion(q), votesA: stats.votesA, votesB: stats.votesB,
      total: stats.total, myOption: v ? v.option : null
    }
  },

  /** 个人页三件套：连答日历 + 少数派战绩 + 最难选择题 TOP */
  getMyStats(args, userId) {
    // 连答日历：答过的全部日期（一天最多一题，数据量极小）
    const calendarDates = db.prepare(
      'SELECT DISTINCT question_date d FROM votes WHERE user_id=? ORDER BY d DESC LIMIT 400'
    ).all(userId).map((r) => r.d)
    // 少数派战绩：样本>=30 且我的选项占比 <= 40% 的次数
    const rows = db.prepare(
      'SELECT v.question_id, v.option FROM votes v JOIN questions q ON q.id=v.question_id '
      + "WHERE v.user_id=? AND q.status='published'"
    ).all(userId)
    const myByQ = new Map(rows.map((r) => [r.question_id, r.option]))
    let answeredTotal = 0, minorityCount = 0
    for (const [qid, opt] of myByQ) {
      const s = countVotes(qid)
      if (s.total < 1) continue
      answeredTotal++
      const mineVotes = opt === 'A' ? s.votesA : s.votesB
      if (s.total >= 30 && mineVotes / s.total <= 0.4) minorityCount++
    }
    // 最难选择题 TOP：往期已上墙题中 |votesA-votesB| 最小的 5 道（样本>=10 才算）
    const today = beijingDate()
    const past = db.prepare(
      'SELECT id, title, optionA, optionB, show_date FROM questions '
      + "WHERE status='published' AND show_date IS NOT NULL AND show_date < ? "
      + 'ORDER BY show_date DESC LIMIT 60'
    ).all(today)
    const hardest = past.map((q) => ({ q, s: countVotes(q.id) }))
      .filter((x) => x.s.total >= 10)
      .sort((a, b) => Math.abs(a.s.votesA - a.s.votesB) - Math.abs(b.s.votesA - b.s.votesB))
      .slice(0, 5)
      .map((x) => ({
        questionId: x.q.id, title: x.q.title, optionA: x.q.optionA, optionB: x.q.optionB,
        date: x.q.show_date, votesA: x.s.votesA, votesB: x.s.votesB, total: x.s.total,
        myOption: myByQ.get(x.q.id) || null
      }))
    return {
      calendarDates, answeredTotal, minorityCount,
      minorityRate: answeredTotal ? Math.round((minorityCount / answeredTotal) * 100) : 0,
      hardest
    }
  },

  /** AI 周报：连答满 7 天解锁；本周统计 + 夜航电台口吻总结，按「人+周」缓存 */
  async getWeeklyReport(args, userId) {
    const today = beijingDate()
    const streak = streakIncludingToday(userId, today)
    if (streak < 7) return { unlocked: false, streak, needDays: 7 - streak }
    // 本周 = 本周一（北京口径）至今
    const bjMidnight = new Date(`${today}T00:00:00+08:00`).getTime()
    const dow = (new Date(bjMidnight).getUTCDay() + 6) % 7 // 周一=0
    const weekStart = beijingDate(new Date(bjMidnight - dow * 86400000))
    const start = bjMidnightUTCISO(weekStart)
    const rows = db.prepare(
      'SELECT option, duration, question_id, question_date FROM votes WHERE user_id=? AND created_at>=? '
      + 'ORDER BY created_at ASC'
    ).all(userId, start)
    if (rows.length === 0) return { unlocked: false, streak, needDays: 7 - streak }

    const days = new Set(rows.map((r) => r.question_date)).size
    const aCount = rows.filter((r) => r.option === 'A').length
    const bCount = rows.length - aCount
    const avgDuration = Math.round(rows.reduce((s, r) => s + (r.duration || 0), 0) / rows.length)
    let minority = 0
    const seen = new Set()
    for (const r of rows) {
      if (seen.has(r.question_id)) continue // 每人每题一条，天然去重
      seen.add(r.question_id)
      const s = countVotes(r.question_id)
      const mineVotes = r.option === 'A' ? s.votesA : s.votesB
      if (s.total >= 30 && mineVotes / s.total <= 0.4) minority++
    }

    const fallbackText = `这一周你答了 ${days} 天，${aCount} 次选了前一个，${bCount} 次选了后一个，`
      + `平均想 ${avgDuration} 秒。`
      + (minority
        ? `有 ${minority} 次你站在了少数那边——夜航都记着呢。`
        : `这周你没怎么逆行，稳稳地跟着自己走。`)
      + '下周零点，电台还在。'

    const cacheKey = `weekly-${userId}-${weekStart}`
    const cached = db.prepare('SELECT text FROM ai_profiles WHERE cache_key=?').get(cacheKey)
    if (cached) {
      return { unlocked: true, weekStart, days, minorityCount: minority, avgDuration, report: cached.text }
    }
    let report = fallbackText
    try {
      const prompt = [
        '## 你的人设',
        '你是「夜航电台」的主理人，代号"老航"。说话简短、有画面感、偶尔冷幽默，不说教。',
        '',
        '## 这位听众本周的答题记录',
        `本周答了 ${days} 天；选前一个选项 ${aCount} 次、后一个 ${bCount} 次；平均决策 ${avgDuration} 秒；`,
        minority ? `有 ${minority} 次站到了少数派那边（占比不到 40%）。` : '本周没有站过少数派。',
        '',
        '## 本周人格报告',
        '- 80~120 个字，用第二人称"你"，像电台周更栏目里念的一段开场白',
        '- 概括他这一周的选择风格，可以点一下少数派次数或用时，但别像报数据',
        '- 不做人格定型（禁用心理学标签词），不给建议，不评判对错',
        '- 只输出这段话本身：不要引号、不要解释、不要署名'
      ].join('\n')
      const text = await callAiChat(prompt, 300)
      if (text && text.length >= 10) report = text
    } catch (e) {
      console.error('[weekly] AI 失败，降级模板:', e.message)
    }
    if (report !== fallbackText) {
      db.prepare(
        'INSERT OR IGNORE INTO ai_profiles (cache_key, tag, text, created_at) VALUES (?,?,?,?)'
      ).run(cacheKey, 'weekly', report, nowISO())
    }
    return { unlocked: true, weekStart, days, minorityCount: minority, avgDuration, report }
  }
}

// ---------- HTTP 服务 ----------
function json(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-User-Id'
  })
  res.end(JSON.stringify(obj))
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {})
  const match = req.url.match(/^\/api\/(\w+)$/)
  if (req.method !== 'POST' || !match) return json(res, 404, { code: -1, message: 'not found', data: null })

  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', async () => {
    const name = match[1]
    const handler = handlers[name]
    if (!handler) return json(res, 404, { code: -1, message: `未知接口 ${name}`, data: null })
    const userId = req.headers['x-user-id'] || 'anonymous'
    let args = {}
    try { args = body ? JSON.parse(body) : {} } catch { /* 空 body 容忍 */ }
    try {
      const data = await handler(args, userId)
      json(res, 200, { code: 0, message: 'success', data })
      console.log(`[api] ${name} user=${userId} ok`)
    } catch (e) {
      json(res, 200, { code: -1, message: e.message || '服务异常', data: null })
      console.log(`[api] ${name} user=${userId} fail: ${e.message}`)
    }
  })
})

initSchema()
seed()
server.listen(PORT, () => {
  console.log(`[api] 今天你几成 API 服务已启动: http://localhost:${PORT}  (DB: ${DB_PATH})`)
})
