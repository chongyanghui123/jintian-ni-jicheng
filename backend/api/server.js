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
const crypto = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')

const PORT = process.env.PORT || 3001
const DB_PATH = path.join(__dirname, '..', 'admin', 'admin.db')
const QUESTIONS_TS = path.join(__dirname, '..', '..', 'miniprogram', 'src', 'data', 'questions.ts')
const UPLOADS_DIR = path.join(__dirname, 'uploads') // 用户头像存储目录

// ---------- AI 配置（backend/api/config.json；apiKey 为空时自动降级模板文案） ----------
let AI_CONFIG = {
  apiKey: '',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4', // OpenAI 兼容：智谱 / DeepSeek / 豆包等均可
  model: 'glm-4-flash',
  timeoutMs: 8000
}
// 微信小程序配置（config.json 的 wx 块）：appid/secret 用于 code2session
let WX_CONFIG = { appid: '', secret: '' }
// 文生图配置（config.json 的 image 块）：智谱 CogView-4 生成每日题目分享图
let IMG_CONFIG = {
  apiKey: '',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  model: 'cogview-4',
  size: '1152x864',
  timeoutMs: 60000
}
// 鉴权配置（config.json 的 auth 块）：写操作需要登录 token；allowAnonymous 仅供本地 e2e 开发
let AUTH_CONFIG = { allowAnonymous: false, tokenDays: 30 }
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'))
  if (cfg.ai) AI_CONFIG = { ...AI_CONFIG, ...cfg.ai, ...(process.env.AI_API_KEY ? { apiKey: process.env.AI_API_KEY } : {}) }
  // 微信小程序配置：secret 用于 code2session 换 openid；为空时 login 接口自动降级本地 ID
  if (cfg.wx) WX_CONFIG = { ...WX_CONFIG, ...cfg.wx, ...(process.env.WX_APPSECRET ? { secret: process.env.WX_APPSECRET } : {}) }
  if (cfg.image) IMG_CONFIG = { ...IMG_CONFIG, ...cfg.image, ...(process.env.IMAGE_API_KEY ? { apiKey: process.env.IMAGE_API_KEY } : {}) }
  if (cfg.auth) AUTH_CONFIG = { ...AUTH_CONFIG, ...cfg.auth }
} catch { /* 没有配置文件则用默认 */ }


// ---------- 北京时间口径（文档 11.3）：一切日期以 UTC+8 换算 ----------
function beijingDate(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}
function nowISO() {
  return new Date().toISOString() // UTC ISO，所有 created_at 统一此格式
}

/**
 * 北京时间的「此刻」上下文：日期、星期、小时、时段、节日。
 * 给 AI 文案提供时间感（深夜/清晨/节日），避免点评千篇一律。
 * 节日只列固定公历日期；农历节日（春节/中秋等）需要历表，未纳入。
 */
const FIXED_FESTIVALS = {
  '01-01': '元旦', '02-14': '情人节', '03-08': '妇女节', '05-01': '劳动节',
  '06-01': '儿童节', '10-01': '国庆节', '12-24': '平安夜', '12-25': '圣诞节', '12-31': '跨年夜'
}
function beijingTimeContext(d = new Date()) {
  const bj = new Date(d.getTime() + 8 * 3600 * 1000)
  const hour = bj.getUTCHours()
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const seg = hour < 5 ? '凌晨' : hour < 8 ? '清晨' : hour < 11 ? '上午' : hour < 13 ? '中午'
    : hour < 17 ? '下午' : hour < 19 ? '傍晚' : hour < 23 ? '晚上' : '深夜'
  const date = bj.toISOString().slice(0, 10)
  return {
    date,
    hour,
    weekday: weekdays[bj.getUTCDay()],
    seg,
    festival: FIXED_FESTIVALS[date.slice(5)] || ''
  }
}
function bjMidnightUTCISO(dayStr) {
  return new Date(`${dayStr}T00:00:00+08:00`).toISOString() // 北京零点对应的 UTC 时刻
}

// ---------- 数据库 ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')

// ---------- 运行指标：/health 暴露，便于外部监控与排查（进程内累计，重启清零） ----------
const metrics = { startedAt: Date.now(), requests: 0, errors: 0, slow: 0, aiFails: 0, imgFails: 0, lastError: '' }
function noteError(msg) {
  metrics.errors++
  metrics.lastError = `${nowISO()} ${msg}`
}

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
      image TEXT NOT NULL DEFAULT '',
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
    CREATE TABLE IF NOT EXISTS share_images (
      question_id TEXT PRIMARY KEY,
      file TEXT NOT NULL,
      show_date TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      nickname TEXT DEFAULT '',
      avatar TEXT DEFAULT '',
      wx_openid TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      banned_reason TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      contact TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      reply TEXT DEFAULT '',
      reward INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      handled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wheel_prizes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'points',
      value INTEGER NOT NULL DEFAULT 0,
      weight INTEGER NOT NULL DEFAULT 1,
      stock INTEGER NOT NULL DEFAULT -1,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0,
      image TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS draw_chances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      ref_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_draw_chance_ref
      ON draw_chances(user_id, ref_id) WHERE ref_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS wheel_draws (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      prize_id TEXT,
      prize_name TEXT NOT NULL,
      prize_type TEXT NOT NULL DEFAULT 'none',
      prize_value INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'won',
      contact_name TEXT DEFAULT '',
      contact_phone TEXT DEFAULT '',
      contact_address TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wheel_draws_user ON wheel_draws(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_questions_show_date ON questions(show_date);
    CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
    CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_votes_question ON votes(question_id, option);
    CREATE INDEX IF NOT EXISTS idx_votes_user_date ON votes(user_id, question_date);
    CREATE INDEX IF NOT EXISTS idx_comments_question ON comments(question_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_user ON points_ledger(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_user ON redeem_orders(user_id);
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
  for (const [table, col] of [['comments', 'user_id'], ['submissions', 'user_id'], ['reports', 'user_id'], ['reports', 'result']]) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all()
    if (!cols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT DEFAULT ''`)
    }
  }
  // 兼容升级：奖品图片列（后台新增/编辑奖品时上传）
  const pcols = db.prepare('PRAGMA table_info(prizes)').all()
  if (!pcols.some((c) => c.name === 'image')) {
    db.exec("ALTER TABLE prizes ADD COLUMN image TEXT NOT NULL DEFAULT ''")
  }
  // 兼容升级：relook_draws 早期带 UNIQUE(user_id, draw_date)，限制每天只能一道；
  // 现在每天抽取次数后台可配（可能 >1），检测到旧唯一约束则重建表
  const relookSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='relook_draws'").get()
  if (relookSql && /UNIQUE/i.test(relookSql.sql)) {
    db.exec(`
      ALTER TABLE relook_draws RENAME TO relook_draws_old;
      CREATE TABLE relook_draws (
        user_id TEXT NOT NULL, draw_date TEXT NOT NULL, question_id TEXT NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO relook_draws (user_id, draw_date, question_id, created_at)
        SELECT user_id, draw_date, question_id, created_at FROM relook_draws_old;
      DROP TABLE relook_draws_old;
    `)
    console.log('[db] relook_draws 已升级为支持每天多次回看')
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

  const wcount = db.prepare('SELECT COUNT(*) c FROM wheel_prizes').get().c
  if (wcount === 0) {
    const ins = db.prepare(
      'INSERT INTO wheel_prizes (id, name, type, value, weight, stock, enabled, sort) VALUES (?,?,?,?,?,?,?,?)')
    ins.run('w_none', '谢谢参与', 'none', 0, 30, -1, 1, 1)
    ins.run('w_p5', '5 积分', 'points', 5, 25, -1, 1, 2)
    ins.run('w_p10', '10 积分', 'points', 10, 20, -1, 1, 3)
    ins.run('w_p20', '20 积分', 'points', 20, 12, -1, 1, 4)
    ins.run('w_p50', '50 积分', 'points', 50, 6, -1, 1, 5)
    ins.run('w_p100', '100 积分', 'points', 100, 2, -1, 1, 6)
    ins.run('w_gift', '实物周边（示例）', 'physical', 0, 3, 5, 1, 7)
    console.log('[seed] 已写入 7 个转盘奖品')
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
// 积分规则默认值：后台「积分规则」可改，实际取值见 pointsRules()
// 答题本身不再直接发积分，积分只通过转盘抽奖获得（points_answer / points_streak7 默认 0）
const POINTS_DEFAULTS = { answer: 2, streak7: 10, dailyCap: 60 }
const BLOCK_WORDS_COMMENT = ['加微信', '加v', '转账', '赌博', '裸', '约炮', '代购', '兼职']
const BLOCK_WORDS_SUBMIT = ['加微信', '加v', '转账', '赌博', '裸', '约炮', '官方', '客服', '管理员']
const CONFIG_DEFAULTS = {
  submit_daily_limit: 3,
  feedback_daily_limit: 3,
  weekly_unlock_streak: 7,
  points_valid_days: 365,
  points_expire_tip_days: 90,
  lookback_draw_per_day: 1,
  lookback_ticket_days: 30,
  report_hide_threshold: 3,
  minority_min_samples: 30,
  minority_ratio_pct: 40,
  skin_valid_days: 30,
  draw_per_answer: 1,
  draw_streak7_bonus: 3,
  draw_daily_cap: 3,
  share_image_interval_min: 15,
  ai_profile_length: 50
}
const CONFIG_BOOL_DEFAULTS = {
  share_image_enabled: true,
  module_submit: true,
  module_feedback: true,
  module_weekly: true,
  module_prizes: true,
  module_relook: true,
  module_wheel: true,
  announcement_enabled: false
}
const CONFIG_TEXT_DEFAULTS = {
  announcement_text: '',
  about_updated_at: '2026-11-23',
  about_intro: '「今天你几成」是一款每日同题投票小程序。我们尽量少收集信息，下面说明清楚收集了什么、怎么用、存在哪里。',
  about_footer: '今天你几成 · 更新于 2026-11-23',
  ai_profile_style: ''
}
const VALID_REASONS = ['low_quality', 'inappropriate', 'violation', 'other']

const mapQuestion = (q) => q && ({
  id: q.id, title: q.title, optionA: q.optionA, optionB: q.optionB, date: q.show_date || ''
})

// ---------- 票数统计：60 秒内存缓存 ----------
// 结果页/周报/昨日揭晓都会读票数，同一题一分钟内只扫一次表；
// 用户自己投票成功时清掉该题缓存，保证投完立刻能看到自己那一票。
const STATS_TTL_MS = 60 * 1000
const statsCache = new Map() // questionId → { votesA, votesB, total, at }

function countVotes(questionId) {
  const hit = statsCache.get(questionId)
  if (hit && Date.now() - hit.at < STATS_TTL_MS) {
    return { votesA: hit.votesA, votesB: hit.votesB, total: hit.total }
  }
  const a = db.prepare("SELECT COUNT(*) c FROM votes WHERE question_id=? AND option='A'").get(questionId).c
  const b = db.prepare("SELECT COUNT(*) c FROM votes WHERE question_id=? AND option='B'").get(questionId).c
  statsCache.set(questionId, { votesA: a, votesB: b, total: a + b, at: Date.now() })
  return { votesA: a, votesB: b, total: a + b }
}

function earnedTodaySum(userId, today) {
  const start = bjMidnightUTCISO(today)
  const row = db.prepare(
    "SELECT COALESCE(SUM(amount),0) s FROM points_ledger WHERE user_id=? AND type='earn' AND created_at>=?"
  ).get(userId, start)
  return row.s
}

/** 读一个整数型 settings 配置；缺失或非法时回落默认值，并夹在 [min,max] 内 */
function settingInt(key, def, min, max) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key)
  const n = Number(row && row.value)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function settingBool(key, def) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key)
  if (!row) return def
  return ['1', 'true', 'on', 'yes'].includes(String(row.value).toLowerCase())
}

function settingText(key, def, maxLen = 500) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key)
  const v = row && typeof row.value === 'string' ? row.value : def
  return String(v || '').slice(0, maxLen)
}

/** 运营参数（后台「运营设置」动态配置）：小程序通过 getAppConfig 拉取 */
function appConfig() {
  return {
    submitDailyLimit: settingInt('submit_daily_limit', CONFIG_DEFAULTS.submit_daily_limit, 0, 100),
    feedbackDailyLimit: settingInt('feedback_daily_limit', CONFIG_DEFAULTS.feedback_daily_limit, 0, 100),
    weeklyUnlockStreak: settingInt('weekly_unlock_streak', CONFIG_DEFAULTS.weekly_unlock_streak, 1, 100),
    pointsValidDays: settingInt('points_valid_days', CONFIG_DEFAULTS.points_valid_days, 1, 3650),
    pointsExpireTipDays: settingInt('points_expire_tip_days', CONFIG_DEFAULTS.points_expire_tip_days, 1, 3650),
    lookbackDrawPerDay: settingInt('lookback_draw_per_day', CONFIG_DEFAULTS.lookback_draw_per_day, 1, 20),
    lookbackTicketDays: settingInt('lookback_ticket_days', CONFIG_DEFAULTS.lookback_ticket_days, 1, 3650),
    reportHideThreshold: settingInt('report_hide_threshold', CONFIG_DEFAULTS.report_hide_threshold, 0, 100),
    minorityMinSamples: settingInt('minority_min_samples', CONFIG_DEFAULTS.minority_min_samples, 0, 100000),
    minorityRatioPct: settingInt('minority_ratio_pct', CONFIG_DEFAULTS.minority_ratio_pct, 0, 100),
    skinValidDays: settingInt('skin_valid_days', CONFIG_DEFAULTS.skin_valid_days, 1, 3650),
    drawPerAnswer: settingInt('draw_per_answer', CONFIG_DEFAULTS.draw_per_answer, 0, 100),
    drawStreak7Bonus: settingInt('draw_streak7_bonus', CONFIG_DEFAULTS.draw_streak7_bonus, 0, 100),
    drawDailyCap: settingInt('draw_daily_cap', CONFIG_DEFAULTS.draw_daily_cap, 0, 1000),
    shareImageIntervalMin: settingInt('share_image_interval_min', CONFIG_DEFAULTS.share_image_interval_min, 1, 1440),
    shareImageEnabled: settingBool('share_image_enabled', CONFIG_BOOL_DEFAULTS.share_image_enabled),
    aiProfileLength: settingInt('ai_profile_length', CONFIG_DEFAULTS.ai_profile_length, 20, 120),
    aiProfileStyle: settingText('ai_profile_style', CONFIG_TEXT_DEFAULTS.ai_profile_style, 200),
    modules: {
      submit: settingBool('module_submit', CONFIG_BOOL_DEFAULTS.module_submit),
      feedback: settingBool('module_feedback', CONFIG_BOOL_DEFAULTS.module_feedback),
      weekly: settingBool('module_weekly', CONFIG_BOOL_DEFAULTS.module_weekly),
      prizes: settingBool('module_prizes', CONFIG_BOOL_DEFAULTS.module_prizes),
      relook: settingBool('module_relook', CONFIG_BOOL_DEFAULTS.module_relook),
      wheel: settingBool('module_wheel', CONFIG_BOOL_DEFAULTS.module_wheel)
    },
    announcement: {
      enabled: settingBool('announcement_enabled', CONFIG_BOOL_DEFAULTS.announcement_enabled),
      text: settingText('announcement_text', CONFIG_TEXT_DEFAULTS.announcement_text, 200)
    },
    about: {
      updatedAt: settingText('about_updated_at', CONFIG_TEXT_DEFAULTS.about_updated_at, 40),
      intro: settingText('about_intro', CONFIG_TEXT_DEFAULTS.about_intro, 400),
      footer: settingText('about_footer', CONFIG_TEXT_DEFAULTS.about_footer, 100)
    }
  }
}

/** 积分规则（后台「积分管理」动态配置，改完立刻对新发放生效） */
function pointsRules() {
  return {
    answer: settingInt('points_answer', POINTS_DEFAULTS.answer, 0, 1000),
    streak7: settingInt('points_streak7', POINTS_DEFAULTS.streak7, 0, 1000),
    dailyCap: settingInt('points_daily_cap', POINTS_DEFAULTS.dailyCap, 0, 100000)
  }
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
  const expiresBefore = new Date(Date.now() - appConfig().pointsValidDays * 86400000).toISOString()
  const row = db.prepare(
    'SELECT COALESCE(SUM(amount),0) s FROM points_ledger WHERE user_id=? AND created_at>=?'
  ).get(userId, expiresBefore)
  return row.s
}

function ledgerOf(userId, limit = 20) {
  const expiresBefore = new Date(Date.now() - appConfig().pointsValidDays * 86400000).toISOString()
  return db.prepare(
    'SELECT * FROM points_ledger WHERE user_id=? AND created_at>=? ORDER BY created_at DESC LIMIT ?'
  ).all(userId, expiresBefore, limit).map((e) => ({
    id: String(e.id), type: e.type, amount: e.amount, reason: e.reason,
    refId: e.ref_id || undefined, orderNo: e.order_no || undefined, createdAt: e.created_at
  }))
}

/** 少数派口径（后台可调）：样本数下限 + 占比上限（%） */
function minorityCfg() {
  const c = appConfig()
  return { min: c.minorityMinSamples, pct: c.minorityRatioPct }
}

/** 往期回看券有效期的起始时间（后台可调天数，过期券不再可用） */
function ticketCutoffISO() {
  return new Date(Date.now() - appConfig().lookbackTicketDays * 86400000).toISOString()
}

// ---------- 转盘抽奖：次数流水 + 中奖记录 ----------
/** 当天已获得的抽奖次数（按北京时间自然日） */
function drawEarnedToday(userId, today) {
  const start = bjMidnightUTCISO(today)
  return db.prepare(
    'SELECT COALESCE(SUM(amount),0) s FROM draw_chances WHERE user_id=? AND created_at>=?'
  ).get(userId, start).s
}

/** 剩余抽奖次数 = 获得次数 - 已抽次数 */
function drawBalance(userId) {
  const gained = db.prepare(
    'SELECT COALESCE(SUM(amount),0) s FROM draw_chances WHERE user_id=?').get(userId).s
  const used = db.prepare('SELECT COUNT(*) c FROM wheel_draws WHERE user_id=?').get(userId).c
  return Math.max(0, gained - used)
}

/** 发放抽奖次数：受单日上限约束，refId 幂等 */
function grantDrawChances(userId, amount, reason, refId, today) {
  if (amount <= 0) return 0
  const cap = appConfig().drawDailyCap
  const left = Math.max(0, cap - drawEarnedToday(userId, today))
  const give = Math.min(amount, left)
  if (give <= 0) return 0
  if (refId) {
    const exist = db.prepare(
      'SELECT 1 FROM draw_chances WHERE user_id=? AND ref_id=?').get(userId, refId)
    if (exist) return 0
  }
  db.prepare(
    'INSERT INTO draw_chances (user_id, amount, reason, ref_id, created_at) VALUES (?,?,?,?,?)'
  ).run(userId, give, reason, refId || null, nowISO())
  return give
}

// ---------- 答题奖励积分：单日上限 + refId 幂等 ----------
/** 当天已获得的答题积分（按北京时间自然日，仅 earn） */
function pointsEarnedToday(userId, today) {
  const start = bjMidnightUTCISO(today)
  return db.prepare(
    "SELECT COALESCE(SUM(amount),0) s FROM points_ledger WHERE user_id=? AND type='earn' AND created_at>=?"
  ).get(userId, start).s
}

/** 发放积分：受单日上限约束，refId 幂等，返回实际发放值 */
function grantPoints(userId, amount, reason, refId, today) {
  if (amount <= 0) return 0
  if (refId) {
    const exist = db.prepare(
      "SELECT 1 FROM points_ledger WHERE user_id=? AND ref_id=? AND type='earn'").get(userId, refId)
    if (exist) return 0
  }
  const left = Math.max(0, pointsRules().dailyCap - pointsEarnedToday(userId, today))
  const give = Math.min(amount, left)
  if (give <= 0) return 0
  db.prepare(
    'INSERT INTO points_ledger (user_id, type, amount, reason, ref_id, created_at) VALUES (?,?,?,?,?,?)'
  ).run(userId, 'earn', give, reason, refId || null, nowISO())
  return give
}

// ---------- 意见采纳奖励积分 ----------
function feedbackRewardDefault() {
  const row = db.prepare("SELECT value FROM settings WHERE key='feedback_reward_points'").get()
  const n = parseInt(row ? row.value : '', 10)
  return Number.isFinite(n) && n >= 0 ? n : 20
}

/** 用户档案：写操作前调用，保证后台用户列表覆盖所有活跃用户（含存量本地 ID） */
function ensureUser(userId) {
  if (!userId || userId === 'anonymous') return
  db.prepare('INSERT OR IGNORE INTO users (id, wx_openid) VALUES (?,?)')
    .run(userId, userId.startsWith('u_') ? '' : userId)
}

/** 是否被封禁（档案不存在视为未封禁） */
function isBanned(userId) {
  const row = db.prepare('SELECT status FROM users WHERE id=?').get(userId)
  return !!row && row.status === 'banned'
}

// ---------- 登录凭证：HMAC 签名 token（防止伪造 X-User-Id 刷票/刷积分） ----------
/** 签名密钥：首次使用时生成并存入 settings，重启后复用 */
function authSecret() {
  const row = db.prepare("SELECT value FROM settings WHERE key='auth_secret'").get()
  if (row && row.value) return row.value
  const secret = crypto.randomBytes(32).toString('hex')
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('auth_secret', ?)").run(secret)
  return secret
}

/** 签发 token：`过期时间.签名`，默认 30 天 */
function signToken(userId) {
  const exp = Date.now() + (AUTH_CONFIG.tokenDays || 30) * 86400000
  const sig = crypto.createHmac('sha256', authSecret()).update(`${userId}:${exp}`).digest('hex')
  return `${exp}.${sig}`
}

function verifyToken(userId, token) {
  if (!token || typeof token !== 'string') return false
  const [expStr, sig] = token.split('.')
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false
  const want = crypto.createHmac('sha256', authSecret()).update(`${userId}:${exp}`).digest('hex')
  const a = Buffer.from(sig)
  const b = Buffer.from(want)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * 写操作身份校验：必须是已绑定 openid 的登录用户，且 token 有效。
 * 本地开发/e2e 可在 config.json 的 auth.allowAnonymous 放开（线上保持默认 false）。
 */
function requireAuth(userId, token) {
  if (AUTH_CONFIG.allowAnonymous) return
  const row = db.prepare('SELECT wx_openid FROM users WHERE id=?').get(userId)
  const err = new Error(!row || !row.wx_openid ? '请先登录' : '登录已过期，请重新登录')
  err.code = 4010
  if (!row || !row.wx_openid) throw err
  if (!verifyToken(userId, token)) throw err
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
async function aiGenerateText({ args, key, tag, fallbackText }) {  if (!AI_CONFIG.apiKey) return fallbackText
  const q = db.prepare('SELECT * FROM questions WHERE id=?').get(args.questionId)
  const optionText = q ? (args.option === 'A' ? q.optionA : q.optionB) : ''
  const ratio = typeof args.ratio === 'number' ? args.ratio : -1
  const pct = ratio >= 0 ? Math.round(ratio) : null
  // 北京时间上下文（时段/星期/节日）：让点评带当下的时间感
  const ctx = beijingTimeContext()
  const aiCfg = appConfig()
  const aiLen = aiCfg.aiProfileLength
  const styleTips = aiCfg.aiProfileStyle ? [`- 额外风格要求：${aiCfg.aiProfileStyle}`] : []
  const prompt = [
    `## 你的人设`,
    `你是「夜航电台」的主理人，代号"阳仔"。每晚零点，你守着一档叫「今天你几成」的栏目,`,
    `看千万个网友为同一道两难题纠结、站队。你像一个通透但不油腻的老朋友：`,
    `见过太多深夜的摇摆，所以不轻易评判别人；说话简短、有画面感、偶尔冷幽默，`,
    `擅长用一个具体的小场景把人的选择说透，结尾常常留一点余味，不说教。`,
    ``,
    `## 此刻这位听众`,
    `题目：《${q ? q.title : ''}》，他选了「${optionText}」，决策用时 ${args.duration || 0} 秒，`,
    pct === null ? `占比未知。` : `目前有 ${pct}% 的人和他选了同一边。`,
    `现在是北京时间 ${ctx.date} ${ctx.weekday} ${ctx.hour} 点（${ctx.seg}）${ctx.festival ? `，今天是${ctx.festival}` : ''}。`,
    `他的风格标签是「${tag}」（${key}）。`,
    ``,
    `## 此刻你对他说的话`,
    `- 约 ${aiLen} 个字（${Math.max(15, aiLen - 15)}~${aiLen + 10} 字），用第二人称"你"，像电台里轻声说的那句点评`,
    `- 把当下的时间感自然写进去：现在是${ctx.seg}${ctx.festival ? `、正值${ctx.festival}` : ''}，可以随口带一句，别报时钟、别生硬`,
    `- 可以点一下他的用时、占比或标签，但别像报数据，要像唠嗑`,
    `- 不做人格定型（禁用"回避型""讨好型"等心理学标签词），不给建议，不评判对错`,
    ...styleTips,
    `- 只输出这段话本身：不要引号、不要解释、不要署名`
  ].join('\n')
  try {
    return await callAiChat(prompt)
  } catch (e) {
    metrics.aiFails++
    console.error('[ai] 调用失败，降级模板:', e.message)
    return fallbackText
  }
}

// ---------- 每日分享图：DeepSeek 润色画面描述 → CogView 出图；按天缓存，过天自动删除 ----------
const SHARE_IMG_DIR = path.join(UPLOADS_DIR, 'share')
const shareImagePending = new Map() // questionId → Promise，避免并发重复烧额度

/** 题目 → 文生图 prompt：先让 AI 把题面改写成画面描述，失败用固定模板 */
async function craftSharePrompt(q) {
  const fallback = `扁平插画：围绕「${q.title}」，同框画出代表「${q.optionA}」与「${q.optionB}」的对立小场景，` +
    `暖色灯光、夜色治愈氛围，构图居中，画面中不要出现任何文字。`
  if (!AI_CONFIG.apiKey) return fallback
  try {
    const text = await callAiChat([
      '你是插画提示词工程师。把下面这道日常选择题改写成一句适合文生图模型的中文画面描述。',
      '要求：1) 只输出描述本身，不要解释、不要加引号；2) 40~60 字，短而具体；',
      '3) 描绘一个具体可视化的生活场景，让人一眼看出是两种选择的对立；',
      '4) 风格固定为扁平插画、暖色调、夜色氛围、治愈感；5) 必须写明「画面中不要出现任何文字」；',
      '6) 不出现真实品牌、真人明星、政治宗教元素。',
      `题目：${q.title}｜选项A：${q.optionA}｜选项B：${q.optionB}`
    ].join('\n'), 260)
    return text && text.length >= 20 ? text : fallback
  } catch (e) {
    console.error('[share-img] prompt 润色失败，用模板:', e.message)
    return fallback
  }
}

/** 调文生图接口出图，落盘到 uploads/share/<questionId>.<ext> 并登记 */
async function generateShareImage(q) {
  if (!IMG_CONFIG.apiKey) throw new Error('未配置文生图 Key')
  const prompt = await craftSharePrompt(q)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), IMG_CONFIG.timeoutMs || 60000)
  try {
    const res = await fetch(`${IMG_CONFIG.baseUrl.replace(/\/$/, '')}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${IMG_CONFIG.apiKey}` },
      body: JSON.stringify({ model: IMG_CONFIG.model, prompt, size: IMG_CONFIG.size, watermark_enabled: true }),
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`生图 HTTP ${res.status}`)
    const data = await res.json()
    const remoteUrl = data.data && data.data[0] && data.data[0].url
    if (!remoteUrl) throw new Error('生图返回空')
    const imgRes = await fetch(remoteUrl)
    if (!imgRes.ok) throw new Error(`下载图片 HTTP ${imgRes.status}`)
    const buf = Buffer.from(await imgRes.arrayBuffer())
    if (!buf.length || buf.length > 8 * 1024 * 1024) throw new Error(`图片体积异常 ${buf.length}`)
    fs.mkdirSync(SHARE_IMG_DIR, { recursive: true })
    const ext = /\.png(\?|$)/i.test(remoteUrl) ? '.png' : '.jpg'
    const file = `${q.id}${ext}`
    fs.writeFileSync(path.join(SHARE_IMG_DIR, file), buf)
    db.prepare('INSERT OR REPLACE INTO share_images (question_id, file, show_date, created_at) VALUES (?,?,?,?)')
      .run(q.id, file, beijingDate(), nowISO())
    console.log(`[share-img] ${q.id} 生成成功 ${(buf.length / 1024).toFixed(0)}KB`)
    return file
  } finally {
    clearTimeout(timer)
  }
}

/** 取当天该题的分享图：命中缓存直接用，否则生成（并发去重） */
async function ensureShareImage(q) {
  const row = db.prepare('SELECT file, show_date FROM share_images WHERE question_id=?').get(q.id)
  if (row && row.show_date === beijingDate() && fs.existsSync(path.join(SHARE_IMG_DIR, row.file))) {
    return row.file
  }
  if (shareImagePending.has(q.id)) return shareImagePending.get(q.id)
  const task = generateShareImage(q).finally(() => shareImagePending.delete(q.id))
  shareImagePending.set(q.id, task)
  return task
}

/** 清理非当天的分享图记录与文件（含库中已无记录的孤儿文件） */
function cleanupShareImages() {
  const today = beijingDate()
  let removed = 0
  try {
    fs.mkdirSync(SHARE_IMG_DIR, { recursive: true })
    const rows = db.prepare('SELECT file FROM share_images WHERE show_date != ?').all(today)
    for (const r of rows) {
      try { fs.unlinkSync(path.join(SHARE_IMG_DIR, r.file)) } catch { /* 文件已不在 */ }
      removed++
    }
    if (rows.length) db.prepare('DELETE FROM share_images WHERE show_date != ?').run(today)
    const alive = new Set(db.prepare('SELECT file FROM share_images').all().map((r) => r.file))
    for (const f of fs.readdirSync(SHARE_IMG_DIR)) {
      if (!alive.has(f)) {
        try { fs.unlinkSync(path.join(SHARE_IMG_DIR, f)); removed++ } catch { /* ignore */ }
      }
    }
  } catch (e) {
    console.error('[share-img] 清理失败:', e.message)
  }
  if (removed) console.log(`[share-img] 清理过期分享图 ${removed} 张`)
}

/** 每日任务：先清理昨天及以前的图，再为当天题目预生成 */
async function dailyShareImageJob() {
  cleanupShareImages()
  const now = Date.now()
  for (const [qid, s] of statsCache) if (now - s.at > 86400000) statsCache.delete(qid)
  try {
    const q = db.prepare(
      "SELECT * FROM questions WHERE show_date=? AND status='published' LIMIT 1").get(beijingDate())
    if (!q) return
    const row = db.prepare('SELECT file, show_date FROM share_images WHERE question_id=?').get(q.id)
    if (row && row.show_date === beijingDate() && fs.existsSync(path.join(SHARE_IMG_DIR, row.file))) return
    await ensureShareImage(q)
  } catch (e) {
    metrics.imgFails++
    console.error('[share-img] 预生成失败:', e.message)
  }
}

const handlers = {
  /** 微信登录：code → openid（code2session）。未配 secret 或失败时返回 degraded，客户端静默降级本地 ID */
  async login(args, userId) {
    if (!WX_CONFIG.appid || !WX_CONFIG.secret || !args.code) {
      // 未配置 AppSecret（本地开发模式）：降级登录，仍为当前身份建档，
      // 保证资料/答题记录在用户管理里有归属；部署后配好 secret 即走下方 openid 分支
      if (userId) ensureUser(userId)
      return { degraded: true, userId: userId || '' }
    }
    try {
      const url = 'https://api.weixin.qq.com/sns/jscode2session?appid=' + WX_CONFIG.appid
        + '&secret=' + encodeURIComponent(WX_CONFIG.secret)
        + '&js_code=' + encodeURIComponent(args.code)
        + '&grant_type=authorization_code'
      const d = await (await fetch(url)).json()
      if (!d.openid) {
        console.error('[login] code2session 失败:', d.errcode, d.errmsg)
        return { degraded: true }
      }
      ensureUser(d.openid)
      db.prepare('UPDATE users SET wx_openid=?, updated_at=? WHERE id=?')
        .run(d.openid, nowISO(), d.openid)
      return { userId: d.openid, degraded: false, token: signToken(d.openid) }
    } catch (e) {
      console.error('[login] 调用异常:', e.message)
      return { degraded: true }
    }
  },

  getProfile(args, userId) {
    const row = db.prepare('SELECT id, nickname, avatar, status FROM users WHERE id=?').get(userId)
    return row || { id: userId, nickname: '', avatar: '', status: 'active' }
  },

  updateProfile(args, userId) {
    const nickname = (args.nickname || '').trim().slice(0, 20)
    ensureUser(userId)
    db.prepare('UPDATE users SET nickname=?, updated_at=? WHERE id=?')
      .run(nickname, nowISO(), userId)
    return { nickname }
  },

  /** 头像上传：客户端读 base64 后 JSON 提交（请求体不做 multipart），存 backend/api/uploads/ */
  uploadAvatar(args, userId) {
    const { data, ext } = args
    if (!data || !['jpg', 'jpeg', 'png', 'webp'].includes(ext)) throw new Error('参数错误')
    const buf = Buffer.from(data, 'base64')
    if (buf.length === 0 || buf.length > 400 * 1024) throw new Error('头像大小超出限制')
    ensureUser(userId)
    const safeId = String(userId).replace(/[^\w-]/g, '')
    const file = `${safeId}_${Date.now()}.${ext}`
    fs.mkdirSync(UPLOADS_DIR, { recursive: true })
    fs.writeFileSync(path.join(UPLOADS_DIR, file), buf)
    const url = `/uploads/${file}`
    db.prepare('UPDATE users SET avatar=?, updated_at=? WHERE id=?').run(url, nowISO(), userId)
    return { url }
  },

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
    statsCache.delete(questionId) // 刚投票成功，让下一次统计立刻包含这一票

    // 奖励发放（服务端发放，幂等；失败不影响投票）：答题即发积分 + 转盘抽奖次数
    let earnedDraws = 0, earnedPoints = 0, earnedReason
    try {
      const cfg = appConfig()
      const pr = pointsRules()
      const p1 = grantPoints(userId, pr.answer, '每日答题', `answer-${questionId}`, today)
      const d1 = grantDrawChances(userId, cfg.drawPerAnswer, '每日答题', questionId, today)
      earnedPoints += p1
      if (d1) { earnedDraws += d1 }
      if (p1 || d1) earnedReason = '每日答题'
      const streak = streakIncludingToday(userId, today)
      if (streak > 0 && streak % 7 === 0) {
        const cycleStart = beijingDate(new Date(
          new Date(`${today}T00:00:00+08:00`).getTime() - (streak - 1) * 86400000))
        const p2 = grantPoints(userId, pr.streak7, '连续答题 7 天奖励', `streak7-${cycleStart}`, today)
        const d2 = grantDrawChances(userId, cfg.drawStreak7Bonus, '连答 7 天奖励', `streak7-${cycleStart}`, today)
        earnedPoints += p2
        if (d2) earnedDraws += d2
        if (p2 || d2) {
          earnedReason = earnedReason ? `${earnedReason} + 连答 7 天奖励` : '连答 7 天奖励'
        }
      }
    } catch (e) { console.error('[submitVote] grant reward failed:', e.message) }

    return { ...countVotes(questionId), myOption: option, earnedPoints, earnedDraws, earnedReason }
  },

  getVoteResult(args, userId) {
    const { questionId } = args
    if (!questionId) throw new Error('缺少题目 ID')
    const q = db.prepare('SELECT * FROM questions WHERE id=?').get(questionId)
    if (!q || q.status !== 'published') throw new Error('题目不存在或已下架')
    const stats = countVotes(questionId)
    const v = db.prepare('SELECT option, duration FROM votes WHERE user_id=? AND question_id=?').get(userId, questionId)
    return {
      question: mapQuestion(q), votesA: stats.votesA, votesB: stats.votesB,
      total: stats.total, myOption: v ? v.option : null, myDuration: v ? (v.duration || 0) : 0,
      isExpired: q.show_date !== beijingDate()
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

  /** 每日分享图：当天已生成则直接返回，否则现生成；失败返回空 url 由客户端用内置默认图 */
  async getShareImage(args) {
    if (!appConfig().shareImageEnabled) return { url: '', date: beijingDate() }
    const questionId = args.questionId
    if (!questionId) throw new Error('参数错误')
    const q = db.prepare('SELECT * FROM questions WHERE id=?').get(questionId)
    if (!q) throw new Error('题目不存在')
    // 只为当天已发布题生成：既符合「每天不同」，也避免被随意传历史题号消耗生图额度
    if (q.status !== 'published' || q.show_date !== beijingDate()) return { url: '', date: beijingDate() }
    try {
      const file = await ensureShareImage(q)
      return { url: `/uploads/share/${file}`, date: beijingDate() }
    } catch (e) {
      metrics.imgFails++
      console.error('[share-img] 生成失败，回退默认图:', e.message)
      return { url: '', date: beijingDate() }
    }
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

  reportContent(args, userId) {
    const { targetType, targetId, reason, detail } = args
    if (!targetId || !VALID_REASONS.includes(reason)) throw new Error('参数错误')
    db.prepare(
      'INSERT INTO reports (target_id, target_type, reason, detail, status, user_id) VALUES (?,?,?,?,?,?)'
    ).run(targetId, targetType === 'comment' ? 'comment' : 'question', reason, (detail || '').slice(0, 40), 'open', userId || '')
    if (targetType === 'comment') {
      const c = db.prepare('SELECT * FROM comments WHERE id=?').get(targetId)
      if (c) {
        const count = (c.report_count || 0) + 1
        const threshold = appConfig().reportHideThreshold
        const hidden = threshold > 0 && count >= threshold ? 1 : c.hidden // 达到阈值自动隐藏（0=关闭）
        db.prepare('UPDATE comments SET report_count=?, hidden=? WHERE id=?').run(count, hidden, targetId)
      }
    }
    return { ok: true }
  },

  /** 我的举报反馈：后台处理时填写的 result 说明会展示给举报人 */
  getMyReports(args, userId) {
    const rows = db.prepare(
      'SELECT id, target_type, target_id, reason, detail, status, result, created_at '
      + 'FROM reports WHERE user_id=? ORDER BY id DESC LIMIT 20'
    ).all(userId)
    return { reports: rows }
  },

  /** 提交意见反馈（每天上限由后台「运营设置」配置） */
  submitFeedback(args, userId) {
    if (!appConfig().modules.feedback) throw new Error('反馈暂未开放')
    const content = (args.content || '').trim()
    const contact = (args.contact || '').trim()
    if (content.length < 5 || content.length > 300) throw new Error('反馈内容需 5~300 字')
    if (contact.length > 50) throw new Error('联系方式最多 50 字')
    const start = bjMidnightUTCISO(beijingDate())
    const todayCount = db.prepare(
      'SELECT COUNT(*) c FROM feedback WHERE user_id=? AND created_at>=?').get(userId, start).c
    const limit = appConfig().feedbackDailyLimit
    if (limit > 0 && todayCount >= limit) throw new Error(`今天已经反馈 ${limit} 条了，明天再来`)
    const createdAt = nowISO()
    const info = db.prepare(
      'INSERT INTO feedback (user_id, content, contact, status, reply, reward, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(userId, content, contact, 'pending', '', 0, createdAt)
    return {
      id: Number(info.lastInsertRowid), content, contact,
      status: 'pending', reward: 0, reply: '', createdAt
    }
  },

  /** 我的反馈列表（含后台回复与获得积分） */
  getMyFeedback(args, userId) {
    const rows = db.prepare(
      'SELECT id, content, contact, status, reply, reward, created_at, handled_at '
      + 'FROM feedback WHERE user_id=? ORDER BY id DESC LIMIT 50'
    ).all(userId)
    return {
      feedbacks: rows.map((f) => ({
        id: f.id, content: f.content, contact: f.contact, status: f.status,
        reply: f.reply || '', reward: f.reward || 0,
        createdAt: f.created_at, handledAt: f.handled_at || ''
      })),
      // 当前采纳奖励积分（后台可改）：用于「被采纳可得 N 积分」提示
      rewardPoints: feedbackRewardDefault()
    }
  },

  getPoints(args, userId) {
    const cfg = appConfig()
    const today = beijingDate()
    const start = bjMidnightUTCISO(today)
    const todayRow = db.prepare(
      "SELECT COALESCE(SUM(amount),0) s FROM points_ledger WHERE user_id=? AND type='earn' AND amount>0 AND created_at>=?"
    ).get(userId, start)
    const validMs = cfg.pointsValidDays * 86400000
    const expiresBefore = new Date(Date.now() - validMs).toISOString()
    const totalRow = db.prepare(
      "SELECT COALESCE(SUM(amount),0) s FROM points_ledger WHERE user_id=? AND amount>0 AND created_at>=?"
    ).get(userId, expiresBefore)
    const titles = db.prepare(
      "SELECT prize_name FROM redeem_orders WHERE user_id=? AND prize_id='p_title' AND status='done'"
    ).all(userId).map((r) => r.prize_name)
    // 即将过期提醒：到期前 N 天内（获得于 validDays-tipDays ~ validDays 天前）的正积分
    const tipDays = Math.min(cfg.pointsExpireTipDays, cfg.pointsValidDays)
    const expStart = new Date(Date.now() - validMs).toISOString()
    const expCutoff = new Date(Date.now() - (cfg.pointsValidDays - tipDays) * 86400000).toISOString()
    const expiringSoon = tipDays > 0 ? db.prepare(
      'SELECT COALESCE(SUM(amount),0) s FROM points_ledger WHERE user_id=? AND amount>0 '
      + 'AND created_at>=? AND created_at<?'
    ).get(userId, expStart, expCutoff).s : 0
    // 限定皮肤「夜航」：兑换完成起 N 天有效（后台可调），过期自动失效
    const skinOrder = db.prepare(
      "SELECT created_at FROM redeem_orders WHERE user_id=? AND prize_id='p_skin' AND status='done' "
      + 'ORDER BY created_at DESC LIMIT 1'
    ).get(userId)
    let skin = null
    if (skinOrder) {
      const expiresAt = new Date(new Date(skinOrder.created_at).getTime()
        + cfg.skinValidDays * 86400000).toISOString()
      if (new Date(expiresAt).getTime() > Date.now()) {
        skin = { id: 'p_skin', name: '夜航', active: true, expiresAt }
      }
    }
    return {
      balance: balanceOf(userId), totalEarned: totalRow.s, earnedToday: todayRow.s,
      expiringSoon, titles, skin, ledger: ledgerOf(userId),
      rules: pointsRules(),
      // 转盘：剩余抽奖次数（「我的」页与积分页共用）
      drawChances: drawBalance(userId),
      drawEarnedToday: drawEarnedToday(userId, today),
      wheelEnabled: cfg.modules.wheel
    }
  },

  getPrizes(args, userId) {
    if (!appConfig().modules.prizes) return []
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
      id: p.id, name: p.name, desc: p.desc, image: p.image || '', cost: p.cost,
      stock: Math.max(0, p.stock - (usedMap[p.id] || 0)),
      monthlyLimit: p.monthly_limit, redeemedThisMonth: myMap[p.id] || 0
    }))
  },

  redeemPrize(args, userId) {
    if (!appConfig().modules.prizes) throw new Error('积分兑换暂未开放')
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
    if (!appConfig().modules.submit) throw new Error('投稿暂未开放')
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
    const limit = appConfig().submitDailyLimit
    if (limit > 0 && todayCount >= limit) throw new Error(`今天已经投了 ${limit} 道，明天再来`)
    const id = `s${Date.now()}${Math.floor(Math.random() * 900 + 100)}`
    db.prepare(
      "INSERT INTO submissions (id, title, optionA, optionB, signature, status, source, user_id, created_at) VALUES (?,?,?,?,?, 'pending', 'miniprogram', ?, ?)"
    ).run(id, title, optionA, optionB, signature, userId, nowISO())
    return { id, title, optionA, optionB, signature, status: 'pending', createdAt: nowISO() }
  },

  getMySubmissions(args, userId) {
    // 上墙日期以题目当前排期为准（后台重排后即时生效），无题目时回退投稿记录上的日期
    return db.prepare(
      'SELECT s.*, q.show_date AS question_show_date FROM submissions s '
      + 'LEFT JOIN questions q ON q.id = s.question_id '
      + 'WHERE s.user_id=? ORDER BY s.created_at DESC LIMIT 50'
    ).all(userId).map((s) => ({
      id: s.id, title: s.title, optionA: s.optionA, optionB: s.optionB,
      signature: s.signature, status: s.status,
      showDate: s.question_show_date || s.show_date || '',
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
    const mc = minorityCfg()
    const records = rows.map((r) => {
      const stats = countVotes(r.question_id)
      const mineVotes = r.option === 'A' ? stats.votesA : stats.votesB
      return {
        questionId: r.question_id, date: r.question_date, title: r.title,
        optionA: r.optionA, optionB: r.optionB, myOption: r.option,
        votesA: stats.votesA, votesB: stats.votesB, total: stats.total,
        isMinority: stats.total >= mc.min && stats.total > 0
          && mineVotes / stats.total * 100 <= mc.pct
      }
    })
    // 回看券状态：是否持券（按后台配置的有效天数）+ 今天是否已抽过
    const hasTicket = !!db.prepare(
      "SELECT 1 FROM redeem_orders WHERE user_id=? AND prize_id='p_relook' AND status='done' "
      + 'AND created_at>=? LIMIT 1'
    ).get(userId, ticketCutoffISO())
    const drawnToday = !!db.prepare(
      'SELECT 1 FROM relook_draws WHERE user_id=? AND draw_date=?').get(userId, beijingDate())
    return { records, relook: { hasTicket, drawnToday } }
  },

  /** 往期回看券：随机抽一道已上墙的往期题（含完整占比；未投过也能看）；每天抽取次数后台可配 */
  drawPastQuestion(args, userId) {
    if (!appConfig().modules.relook) throw new Error('往期回看暂未开放')
    const ticket = db.prepare(
      "SELECT 1 FROM redeem_orders WHERE user_id=? AND prize_id='p_relook' AND status='done' "
      + 'AND created_at>=? LIMIT 1'
    ).get(userId, ticketCutoffISO())
    if (!ticket) throw new Error('需要「往期回看券」，去积分页兑换一张')
    const today = beijingDate()
    const drawnCount = db.prepare(
      'SELECT COUNT(*) c FROM relook_draws WHERE user_id=? AND draw_date=?').get(userId, today).c
    const perDay = appConfig().lookbackDrawPerDay
    if (drawnCount >= perDay) throw new Error(`今天已经回看 ${perDay} 道题了，明天再来`)
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
    const mc = minorityCfg()
    let answeredTotal = 0, minorityCount = 0
    for (const [qid, opt] of myByQ) {
      const s = countVotes(qid)
      if (s.total < 1) continue
      answeredTotal++
      const mineVotes = opt === 'A' ? s.votesA : s.votesB
      if (s.total >= mc.min && mineVotes / s.total * 100 <= mc.pct) minorityCount++
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
    // 累计/连答/平均决策时长：以服务端投票为准（换设备或清缓存后本地记录会丢）
    const totalDays = calendarDates.length
    const streakDays = streakIncludingToday(userId, today)
    const durRow = db.prepare(
      'SELECT AVG(duration) a FROM votes WHERE user_id=? AND duration>0').get(userId)
    const avgDuration = durRow && durRow.a ? Math.round(durRow.a * 10) / 10 : 0
    return {
      calendarDates, answeredTotal, minorityCount,
      minorityRate: answeredTotal ? Math.round((minorityCount / answeredTotal) * 100) : 0,
      totalDays, streakDays, avgDuration,
      hardest
    }
  },

  /** AI 周报：连答达到后台配置天数解锁；滚动 7 天统计 + 夜航电台口吻总结，按「人+天」缓存 */
  async getWeeklyReport(args, userId) {
    if (!appConfig().modules.weekly) throw new Error('周报暂未开放')
    const today = beijingDate()
    const streak = streakIncludingToday(userId, today)
    const need = appConfig().weeklyUnlockStreak
    if (streak < need) return { unlocked: false, streak, needDays: need - streak, unlockStreak: need }
    // 统计区间 = 最近 7 天（含今天，北京口径）：不按自然周切，避免周一刚解锁时只统计到 1 天
    const todayMidnight = new Date(`${today}T00:00:00+08:00`).getTime()
    const windowStart = beijingDate(new Date(todayMidnight - 6 * 86400000))
    const start = bjMidnightUTCISO(windowStart)
    const rows = db.prepare(
      'SELECT option, duration, question_id, question_date FROM votes WHERE user_id=? AND created_at>=? '
      + 'ORDER BY created_at ASC'
    ).all(userId, start)
    if (rows.length === 0) return { unlocked: false, streak, needDays: need - streak, unlockStreak: need }

    const days = new Set(rows.map((r) => r.question_date)).size
    const aCount = rows.filter((r) => r.option === 'A').length
    const bCount = rows.length - aCount
    const avgDuration = Math.round(rows.reduce((s, r) => s + (r.duration || 0), 0) / rows.length)
    const mc = minorityCfg()
    let minority = 0
    const seen = new Set()
    for (const r of rows) {
      if (seen.has(r.question_id)) continue // 每人每题一条，天然去重
      seen.add(r.question_id)
      const s = countVotes(r.question_id)
      const mineVotes = r.option === 'A' ? s.votesA : s.votesB
      if (s.total >= mc.min && mineVotes / s.total * 100 <= mc.pct) minority++
    }

    const fallbackText = `最近 7 天你答了 ${days} 天，${aCount} 次选了前一个，${bCount} 次选了后一个，`
      + `平均想 ${avgDuration} 秒。`
      + (minority
        ? `有 ${minority} 次你站在了少数那边——阳仔都记着呢。`
        : `这 7 天你没怎么逆行，稳稳地跟着自己走。`)
      + '明天零点，电台还在。'

    // 按「人+天」缓存：每天首次查看时生成一次，当天的答题会体现在当天的报告里
    const cacheKey = `weekly-${userId}-${today}`
    const cached = db.prepare('SELECT text FROM ai_profiles WHERE cache_key=?').get(cacheKey)
    if (cached) {
      return { unlocked: true, windowStart, days, minorityCount: minority, avgDuration, report: cached.text }
    }
    let report = fallbackText
    try {
      const prompt = [
        '## 你的人设',
        '你是「夜航电台」的主理人，代号"阳仔"。说话简短、有画面感、偶尔冷幽默，不说教。',
        '',
        '## 这位听众最近 7 天的答题记录',
        `最近 7 天答了 ${days} 天；选前一个选项 ${aCount} 次、后一个 ${bCount} 次；平均决策 ${avgDuration} 秒；`,
        minority ? `有 ${minority} 次站到了少数派那边（占比不到 40%）。` : '最近 7 天没有站过少数派。',
        '',
        '## 最近 7 天人格报告',
        '- 80~120 个字，用第二人称"你"，像电台周更栏目里念的一段开场白',
        '- 概括他这 7 天的选择风格，可以点一下少数派次数或用时，但别像报数据',
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
    return { unlocked: true, windowStart, days, minorityCount: minority, avgDuration, report }
  },

  /** 运营参数：小程序启动/页面进入时拉取（读接口，无需登录） */
  getAppConfig() {
    return appConfig()
  },

  /** 转盘：奖品、剩余次数、今日已得、我的中奖记录 */
  getWheel(args, userId) {
    const cfg = appConfig()
    const today = beijingDate()
    const prizes = db.prepare(
      'SELECT * FROM wheel_prizes WHERE enabled=1 ORDER BY sort, id').all().map((p) => ({
      id: p.id, name: p.name, type: p.type, value: p.value,
      stock: p.stock, image: p.image || '', soldOut: p.stock === 0
    }))
    const draws = db.prepare(
      'SELECT id, prize_id, prize_name, prize_type, prize_value, status, contact_name, '
      + 'contact_phone, contact_address, created_at FROM wheel_draws WHERE user_id=? '
      + 'ORDER BY id DESC LIMIT 20'
    ).all(userId).map((d) => ({
      id: d.id, prizeId: d.prize_id || '', prizeName: d.prize_name, prizeType: d.prize_type,
      prizeValue: d.prize_value, status: d.status, contactName: d.contact_name,
      contactPhone: d.contact_phone, contactAddress: d.contact_address, createdAt: d.created_at
    }))
    return {
      enabled: cfg.modules.wheel,
      balance: drawBalance(userId),
      earnedToday: drawEarnedToday(userId, today),
      prizes,
      draws,
      rules: { perAnswer: cfg.drawPerAnswer, streak7Bonus: cfg.drawStreak7Bonus, dailyCap: cfg.drawDailyCap }
    }
  },

  /** 转盘抽奖：扣 1 次机会，按权重随机；积分奖直接入账，实物奖留收货信息 */
  drawWheel(args, userId) {
    if (!appConfig().modules.wheel) throw new Error('转盘活动暂未开放')
    const balance = drawBalance(userId)
    if (balance <= 0) throw new Error('抽奖次数用完了，答完今天的题可获得次数')
    const pool = db.prepare(
      'SELECT * FROM wheel_prizes WHERE enabled=1 AND (stock=-1 OR stock>0) ORDER BY sort, id').all()
    if (pool.length === 0) throw new Error('奖品还没上架，等等再来')
    const totalWeight = pool.reduce((s, p) => s + Math.max(0, p.weight), 0)
    if (totalWeight <= 0) throw new Error('奖品还没上架，等等再来')
    let r = Math.random() * totalWeight
    let hit = pool[pool.length - 1]
    for (const p of pool) {
      r -= Math.max(0, p.weight)
      if (r <= 0) { hit = p; break }
    }
    db.exec('BEGIN')
    let drawId = 0
    try {
      if (hit.stock > 0) {
        const upd = db.prepare(
          'UPDATE wheel_prizes SET stock=stock-1 WHERE id=? AND stock>0').run(hit.id)
        if (!upd.changes) throw new Error('奖品刚被抽完了，再试一次')
      }
      const status = hit.type === 'physical' ? 'pending_contact' : 'won'
      const info = db.prepare(
        'INSERT INTO wheel_draws (user_id, prize_id, prize_name, prize_type, prize_value, status, created_at) '
        + 'VALUES (?,?,?,?,?,?,?)'
      ).run(userId, hit.id, hit.name, hit.type, hit.value || 0, status, nowISO())
      drawId = Number(info.lastInsertRowid)
      if (hit.type === 'points' && (hit.value || 0) > 0) {
        db.prepare(
          'INSERT INTO points_ledger (user_id, type, amount, reason, ref_id, created_at) VALUES (?,?,?,?,?,?)'
        ).run(userId, 'earn', hit.value, `转盘抽中 ${hit.name}`, `wheel-${drawId}`, nowISO())
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return {
      drawId,
      prize: { id: hit.id, name: hit.name, type: hit.type, value: hit.value || 0, image: hit.image || '' },
      balance: balance - 1,
      needContact: hit.type === 'physical',
      message: hit.type === 'points' ? `抽中 ${hit.value} 积分，已入账`
        : hit.type === 'physical' ? '抽中实物奖品，请填写收货信息' : '谢谢参与，明天再来'
    }
  },

  /** 实物中奖：填写/修改收货信息（仅本人、仅实物奖） */
  setDrawContact(args, userId) {
    const drawId = Math.round(args.drawId || 0)
    const name = (args.name || '').trim().slice(0, 30)
    const phone = (args.phone || '').trim().slice(0, 20)
    const address = (args.address || '').trim().slice(0, 200)
    if (!drawId) throw new Error('缺少中奖记录')
    if (name.length < 1) throw new Error('请填写收货人')
    if (!/^[0-9+\-\s]{6,20}$/.test(phone)) throw new Error('请填写正确的手机号')
    if (address.length < 5) throw new Error('请填写详细收货地址')
    const d = db.prepare('SELECT * FROM wheel_draws WHERE id=? AND user_id=?').get(drawId, userId)
    if (!d) throw new Error('中奖记录不存在')
    if (d.prize_type !== 'physical') throw new Error('该奖品无需填写收货信息')
    db.prepare(
      "UPDATE wheel_draws SET contact_name=?, contact_phone=?, contact_address=?, status='pending_ship', "
      + 'updated_at=? WHERE id=?'
    ).run(name, phone, address, nowISO(), drawId)
    return { ok: true }
  },

  /** 我的中奖记录（默认首页限制 20 条，这里给完整列表供「我的奖品」查看） */
  getMyDraws(args, userId) {
    return db.prepare(
      'SELECT id, prize_id, prize_name, prize_type, prize_value, status, contact_name, '
      + 'contact_phone, contact_address, created_at FROM wheel_draws WHERE user_id=? '
      + 'ORDER BY id DESC LIMIT 100'
    ).all(userId).map((d) => ({
      id: d.id, prizeId: d.prize_id || '', prizeName: d.prize_name, prizeType: d.prize_type,
      prizeValue: d.prize_value, status: d.status, contactName: d.contact_name,
      contactPhone: d.contact_phone, contactAddress: d.contact_address, createdAt: d.created_at
    }))
  }
}

// ---------- HTTP 服务 ----------
function json(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-User-Id, X-User-Token'
  })
  res.end(JSON.stringify(obj))
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {})
  // 用户头像静态服务：GET /uploads/<file>（文件名白名单字符，天然防路径穿越）
  // 每日分享图：GET /uploads/share/<file>（同样白名单，只允许一层文件名）
  const shareMatch = req.method === 'GET' && req.url.match(/^\/uploads\/share\/([\w.-]+)$/)
  if (shareMatch) {
    const file = path.join(SHARE_IMG_DIR, shareMatch[1])
    fs.readFile(file, (err, buf) => {
      if (err) return json(res, 404, { code: -1, message: 'not found', data: null })
      const ctype = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(file).toLowerCase()] || 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' })
      res.end(buf)
    })
    return
  }
  // 奖品图片：GET /uploads/prizes/<file>（后台新增/编辑奖品时上传）
  const prizeImgMatch = req.method === 'GET' && req.url.match(/^\/uploads\/prizes\/([\w.-]+)$/)
  if (prizeImgMatch) {
    const file = path.join(UPLOADS_DIR, 'prizes', prizeImgMatch[1])
    fs.readFile(file, (err, buf) => {
      if (err) return json(res, 404, { code: -1, message: 'not found', data: null })
      const ctype = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(file).toLowerCase()] || 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' })
      res.end(buf)
    })
    return
  }
  const upMatch = req.method === 'GET' && req.url.match(/^\/uploads\/([\w.-]+)$/)
  if (upMatch) {
    const file = path.join(UPLOADS_DIR, upMatch[1])
    fs.readFile(file, (err, buf) => {
      if (err) return json(res, 404, { code: -1, message: 'not found', data: null })
      const ctype = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(file).toLowerCase()] || 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': ctype, 'Access-Control-Allow-Origin': '*' })
      res.end(buf)
    })
    return
  }
  // 健康检查：外部监控可直接 GET /health（含运行指标，重启清零）
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, {
      code: 0,
      data: {
        ok: true,
        uptimeSec: Math.round((Date.now() - metrics.startedAt) / 1000),
        requests: metrics.requests,
        errors: metrics.errors,
        slow: metrics.slow,
        aiFails: metrics.aiFails,
        imgFails: metrics.imgFails,
        lastError: metrics.lastError
      }
    })
  }
  const match = req.url.match(/^\/api\/(\w+)$/)
  if (req.method !== 'POST' || !match) return json(res, 404, { code: -1, message: 'not found', data: null })

  // 写操作统一拦截：先落用户档案（后台用户管理可见），再查封禁状态
  const WRITE_HANDLERS = new Set(['submitVote', 'addComment', 'deleteComment', 'likeComment',
    'submitQuestion', 'redeemPrize', 'reportContent', 'drawPastQuestion', 'updateProfile',
    'uploadAvatar', 'submitFeedback', 'drawWheel', 'setDrawContact'])

  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', async () => {
    const name = match[1]
    const handler = handlers[name]
    if (!handler) return json(res, 404, { code: -1, message: `未知接口 ${name}`, data: null })
    const userId = req.headers['x-user-id'] || 'anonymous'
    const userToken = req.headers['x-user-token'] || ''
    if (WRITE_HANDLERS.has(name)) {
      ensureUser(userId)
      if (isBanned(userId)) {
        json(res, 200, { code: 4030, message: '账号已被封禁，如有疑问请联系运营', data: null })
        return console.log(`[api] ${name} user=${userId} blocked (banned)`)
      }
      // 身份校验：必须是登录用户且 token 有效，杜绝伪造 X-User-Id 刷票/刷积分
      if (userId === 'anonymous') {
        json(res, 200, { code: 4010, message: '请先登录', data: null })
        return console.log(`[api] ${name} blocked (anonymous)`)
      }
      try {
        requireAuth(userId, userToken)
      } catch (e) {
        json(res, 200, { code: e.code || 4010, message: e.message, data: null })
        return console.log(`[api] ${name} user=${userId} blocked (auth): ${e.message}`)
      }
    }
    let args = {}
    try { args = body ? JSON.parse(body) : {} } catch { /* 空 body 容忍 */ }
    const startedAt = Date.now()
    metrics.requests++
    try {
      const data = await handler(args, userId)
      json(res, 200, { code: 0, message: 'success', data })
      const cost = Date.now() - startedAt
      if (cost > 1000) metrics.slow++
      console.log(`[api] ${name} user=${userId} ok${cost > 1000 ? ` (${cost}ms)` : ''}`)
    } catch (e) {
      noteError(`${name} user=${userId}: ${e.message}`)
      json(res, 200, { code: e.code || -1, message: e.message || '服务异常', data: null })
      console.log(`[api] ${name} user=${userId} fail: ${e.message}`)
    }
  })
})

initSchema()
seed()
const HOST = process.env.HOST || '0.0.0.0' // 生产环境可设为 127.0.0.1，只让本机 Nginx 反代访问
server.listen(PORT, HOST, () => {
  console.log(`[api] 今天你几成 API 服务已启动: http://${HOST}:${PORT}  (DB: ${DB_PATH})`)
  // 分享图任务：后台可开关、可调巡检间隔；每分钟检查一次，到点才真正执行
  let lastShareJobAt = 0
  const runShareJob = () => {
    const cfg = appConfig()
    if (!cfg.shareImageEnabled) return
    if (Date.now() - lastShareJobAt < cfg.shareImageIntervalMin * 60000) return
    lastShareJobAt = Date.now()
    dailyShareImageJob().catch(() => {})
  }
  setTimeout(runShareJob, 3000)
  setInterval(runShareJob, 60 * 1000)
})
