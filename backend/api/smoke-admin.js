/* 后台 CRUD 冒烟测试：看板、奖品增改删、题库搜索/分页、订单退款、短评删除、投稿删除、全库备份 */
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(path.join(__dirname, '..', 'admin', 'admin.db'))
const ok = []
const bad = []
function check(name, cond) { (cond ? ok : bad).push(name) }

async function main() {
  const login = await fetch('http://localhost:5050/login', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=admin123', redirect: 'manual'
  })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const H = { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }
  const get = async (u) => (await fetch('http://localhost:5050' + u, { headers: H })).text()
  const post = async (u, body = '') => await fetch('http://localhost:5050' + u, {
    method: 'POST', headers: H, body, redirect: 'manual'
  })

  const dash = await get('/')
  check('看板 / 渲染正常', dash.includes('看板') && dash.includes('题库'))
  const prizesPage = await get('/prizes')
  check('奖品页渲染', prizesPage.includes('奖品管理'))

  // 新增
  await post('/prizes/new', 'name=测试周边马克杯&desc=冒烟测试&cost=100&stock=5&monthly_limit=1')
  const p = db.prepare("SELECT * FROM prizes WHERE name='测试周边马克杯'").get()
  check('新增奖品入库', !!p)
  // 编辑（库存清 0 下架）
  await post(`/prizes/${p.id}/edit`, 'name=测试周边马克杯&desc=冒烟测试&cost=120&stock=0&monthly_limit=2')
  const p2 = db.prepare('SELECT * FROM prizes WHERE id=?').get(p.id)
  check('编辑奖品生效', p2.cost === 120 && p2.stock === 0 && p2.monthly_limit === 2)
  // 删除（无订单 → 允许）
  await post(`/prizes/${p.id}/delete`)
  check('删除奖品', !db.prepare('SELECT 1 FROM prizes WHERE id=?').get(p.id))

  // 造一笔待处理订单 + 积分流水
  db.prepare("INSERT INTO redeem_orders (user_id, order_no, prize_id, prize_name, cost, status, created_at) VALUES ('u_smoke','SMOKE001','p_test','测试奖品',100,'pending',datetime('now','localtime'))").run()
  db.prepare("INSERT INTO points_ledger (user_id, type, amount, reason, ref_id, created_at) VALUES ('u_smoke','earn',2,'答题奖励','r_smoke',datetime('now','localtime'))").run()
  const ordersPage = await get('/orders?user=u_smoke')
  check('订单页用户查询', ordersPage.includes('SMOKE001') && ordersPage.includes('当前积分余额'))

  // —— 撤销退款：pending 订单（未扣分，仅取消） ——
  const oidPending = db.prepare("SELECT id FROM redeem_orders WHERE order_no='SMOKE001'").get().id
  await post(`/orders/${oidPending}/refund`)
  const refunded1 = db.prepare('SELECT status FROM redeem_orders WHERE id=?').get(oidPending)
  const ledgerAfterPending = db.prepare(
    "SELECT COUNT(*) c FROM points_ledger WHERE user_id='u_smoke' AND type='refund'").get().c
  check('pending 订单退款（不加积分流水）', refunded1.status === 'refunded' && ledgerAfterPending === 0)

  // —— 撤销退款：done 订单（回补积分 + refund 流水） ——
  db.prepare("INSERT INTO redeem_orders (user_id, order_no, prize_id, prize_name, cost, status, created_at) VALUES ('u_smoke','SMOKE002','p_test','测试奖品',100,'done',datetime('now','localtime'))").run()
  db.prepare("INSERT INTO points_ledger (user_id, type, amount, reason, order_no, created_at) VALUES ('u_smoke','redeem',-100,'兑换：测试奖品','SMOKE002',datetime('now','localtime'))").run()
  const oidDone = db.prepare("SELECT id FROM redeem_orders WHERE order_no='SMOKE002'").get().id
  await post(`/orders/${oidDone}/refund`)
  const refunded2 = db.prepare('SELECT status FROM redeem_orders WHERE id=?').get(oidDone)
  const refundLedger = db.prepare(
    "SELECT * FROM points_ledger WHERE user_id='u_smoke' AND type='refund' AND order_no='SMOKE002'").get()
  const balance = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM points_ledger WHERE user_id='u_smoke'").get().s
  check('done 订单退款（回补积分+流水）', refunded2.status === 'refunded' && !!refundLedger
    && refundLedger.amount === 100 && balance === 2)
  const ordersPage2 = await get('/orders?user=u_smoke')
  check('订单页显示已退款与退款流水', ordersPage2.includes('已退款') && ordersPage2.includes('退款'))

  // —— 题库搜索 + 分页 ——
  const qPage1 = await get('/questions?tab=all&q=如果&page=1')
  const qPage2 = await get('/questions?tab=all&page=2')
  check('题库搜索渲染', qPage1.includes('搜索题干') && qPage1.includes('题库（'))
  check('题库分页渲染', qPage2.includes('第 2 /'))

  // —— 短评删除 ——
  db.prepare("INSERT INTO comments (id, question_id, option, content, created_at) VALUES ('c_smoke','q_smoke','A','冒烟测试短评',datetime('now','localtime'))").run()
  await post('/comments/c_smoke/delete')
  check('短评删除', !db.prepare('SELECT 1 FROM comments WHERE id=?').get('c_smoke'))

  // —— 投稿删除（pending，不连带题目） ——
  db.prepare("INSERT INTO submissions (id, title, optionA, optionB, status, source, created_at) VALUES ('s_smoke','冒烟投稿测试题','早起','赖床','pending','miniprogram',datetime('now','localtime'))").run()
  await post('/submissions/s_smoke/delete')
  check('投稿删除', !db.prepare('SELECT 1 FROM submissions WHERE id=?').get('s_smoke'))

  // —— 全库备份 ——
  const backup = await fetch('http://localhost:5050/export-all', { headers: H })
  const backupJson = JSON.parse(await backup.text())
  check('全库备份 JSON', backup.status === 200 && !!backupJson.tables
    && Array.isArray(backupJson.tables.questions) && !!backupJson.exported_at)

  // —— AI 缓存清理（先插一条假缓存） ——
  db.prepare("INSERT OR REPLACE INTO ai_profiles (cache_key, tag, text, created_at) VALUES ('smoke','理智型','测试文案',datetime('now','localtime'))").run()
  await post('/ai-cache/clear')
  check('AI 缓存清理', db.prepare('SELECT COUNT(*) c FROM ai_profiles').get().c === 0)

  // ===== 小程序 API 新接口（需 API 服务 :3001） =====
  const callApi = async (name, args = {}, uid = 'u_smoke') => {
    const r = await fetch('http://localhost:3001/api/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': uid },
      body: JSON.stringify(args)
    })
    return await r.json()
  }

  // 给 u_smoke 造两条历史投票（往期已上墙题）
  const pastQs = db.prepare(
    "SELECT id, show_date FROM questions WHERE status='published' AND show_date IS NOT NULL "
    + "AND show_date < date('now','localtime') ORDER BY show_date DESC LIMIT 2").all()
  for (const [i, q] of pastQs.entries()) {
    db.prepare('INSERT OR IGNORE INTO votes (user_id, question_id, question_date, option, duration, created_at) VALUES (?,?,?,?,?,?)')
      .run('u_smoke', q.id, q.show_date, i % 2 ? 'B' : 'A', 5, new Date().toISOString())
  }
  const hist = await callApi('getMyHistory')
  check('getMyHistory 返回历史', hist.code === 0 && hist.data.records.length >= 1
    && hist.data.records.every((r) => r.title && typeof r.total === 'number'))
  check('getMyHistory 回看券状态', hist.code === 0 && hist.data.relook
    && hist.data.relook.hasTicket === false)

  // 个人统计三件套
  const myStats = await callApi('getMyStats')
  check('getMyStats 三件套', myStats.code === 0 && Array.isArray(myStats.data.calendarDates)
    && myStats.data.calendarDates.length >= 1 && typeof myStats.data.minorityCount === 'number'
    && Array.isArray(myStats.data.hardest))

  // 往期回看券：无券被拒 / 有券可抽 / 每天限抽 1 次
  const noTicket = await callApi('drawPastQuestion', {}, 'u_nosmoke')
  check('drawPastQuestion 无券被拒', noTicket.code !== 0)
  db.prepare("INSERT INTO redeem_orders (user_id, order_no, prize_id, prize_name, cost, status, created_at) VALUES ('u_smoke','SMOKELOOK','p_relook','往期回看券',200,'done',datetime('now','localtime'))").run()
  const hist2 = await callApi('getMyHistory')
  check('getMyHistory 有券状态', hist2.code === 0 && hist2.data.relook.hasTicket === true
    && hist2.data.relook.drawnToday === false)
  const drawn = await callApi('drawPastQuestion')
  check('drawPastQuestion 有券抽到往期题', drawn.code === 0 && !!drawn.data && !!drawn.data.question.title)
  const drawnAgain = await callApi('drawPastQuestion')
  check('drawPastQuestion 每天限抽一次', drawnAgain.code !== 0 && drawnAgain.message.includes('明天'))

  // 短评分页字段
  const cQ = pastQs[0].id
  db.prepare("INSERT OR REPLACE INTO comments (id, question_id, option, content, hidden, report_count, user_id, created_at) VALUES ('cs1',?, 'B','冒烟短评一',0,0,'u_smoke2',?)")
    .run(cQ, new Date().toISOString())
  db.prepare("INSERT OR REPLACE INTO comments (id, question_id, option, content, hidden, report_count, user_id, created_at) VALUES ('cs2',?, 'B','冒烟短评二',0,0,'u_smoke2',?)")
    .run(cQ, new Date().toISOString())
  const cPage = await callApi('getComments', { questionId: cQ, offset: 0 })
  check('getComments 分页字段', cPage.code === 0 && cPage.data.total === 2
    && cPage.data.hasMore === false && Array.isArray(cPage.data.comments))

  // —— 短评点赞：toggle 幂等 + 按热度排序 + isLiked ——
  db.prepare("INSERT OR REPLACE INTO comments (id, question_id, option, content, hidden, report_count, user_id, created_at) VALUES ('cs0',?, 'B','冒烟短评零赞',0,0,'u_smoke2',?)")
    .run(cQ, new Date().toISOString())
  const like1 = await callApi('likeComment', { commentId: 'cs1' })
  check('likeComment 点赞', like1.code === 0 && like1.data.liked === true && like1.data.likes === 1)
  const like2 = await callApi('likeComment', { commentId: 'cs1' })
  check('likeComment 取消赞幂等', like2.code === 0 && like2.data.liked === false && like2.data.likes === 0)
  await callApi('likeComment', { commentId: 'cs2' })
  await callApi('likeComment', { commentId: 'cs2' }, 'u_smoke2')
  const cHot = await callApi('getComments', { questionId: cQ, offset: 0 })
  check('getComments 热度排序+isLiked', cHot.code === 0
    && cHot.data.comments[0].id === 'cs2' && cHot.data.comments[0].likes === 2
    && cHot.data.comments.some((c) => c.id === 'cs2' && c.isLiked === true))

  // 积分即将过期字段（-320 天获得的一笔正积分应计入）
  db.prepare("INSERT INTO points_ledger (user_id, type, amount, reason, ref_id, created_at) VALUES ('u_smoke','earn',50,'老奖励','r_old',datetime('now','-320 days','localtime'))").run()
  const pts = await callApi('getPoints')
  check('getPoints 含即将过期', pts.code === 0 && pts.data.expiringSoon >= 50)

  // —— 限定皮肤「夜航」：p_skin 兑换后 30 天内生效 ——
  db.prepare("INSERT INTO redeem_orders (user_id, order_no, prize_id, prize_name, cost, status, created_at) VALUES ('u_smoke','SMOKESKIN','p_skin','限定皮肤「夜航」',300,'done',?)")
    .run(new Date().toISOString())
  const ptsSkin = await callApi('getPoints')
  check('getPoints 夜航皮肤生效', ptsSkin.code === 0 && ptsSkin.data.skin?.active === true
    && typeof ptsSkin.data.skin.expiresAt === 'string')

  // —— AI 周报：未满 7 天锁定 → 造 7 天连答 → 解锁生成 ——
  const weeklyLocked = await callApi('getWeeklyReport')
  check('getWeeklyReport 未满7天锁定', weeklyLocked.code === 0 && weeklyLocked.data.unlocked === false
    && typeof weeklyLocked.data.streak === 'number')
  const bjNow = Date.now() + 8 * 3600 * 1000
  const bjToday = new Date(bjNow).toISOString().slice(0, 10)
  const todayQRow = db.prepare(
    "SELECT id FROM questions WHERE show_date=? AND status='published' LIMIT 1").get(bjToday)
  if (todayQRow) {
    db.prepare('INSERT OR IGNORE INTO votes (user_id, question_id, question_date, option, duration, created_at) VALUES (?,?,?,?,?,?)')
      .run('u_smoke', todayQRow.id, bjToday, 'A', 3, new Date().toISOString())
  }
  for (let off = 1; off <= 6; off++) {
    const d = new Date(bjNow - off * 86400000).toISOString().slice(0, 10)
    db.prepare('INSERT OR IGNORE INTO votes (user_id, question_id, question_date, option, duration, created_at) VALUES (?,?,?,?,?,?)')
      .run('u_smoke', `q_week_smoke_${off}`, d, off % 2 ? 'B' : 'A', 4, new Date().toISOString())
  }
  const weekly = await callApi('getWeeklyReport')
  check('getWeeklyReport 连答7天解锁', weekly.code === 0 && weekly.data.unlocked === true
    && typeof weekly.data.report === 'string' && weekly.data.report.length >= 10
    && (weekly.data.days ?? 0) >= 1)

  // 全库恢复：导出 → 覆盖导入 → 行数一致
  const backupRes = await fetch('http://localhost:5050/export-all', { headers: H })
  const backupJson2 = await backupRes.json()
  const fd = new FormData()
  fd.append('confirm', '1')
  fd.append('file', new Blob([JSON.stringify(backupJson2)], { type: 'application/json' }), 'backup.json')
  const impRes = await fetch('http://localhost:5050/import-all', {
    method: 'POST', headers: { Cookie: cookie }, body: fd, redirect: 'manual'
  })
  const qCount = db.prepare('SELECT COUNT(*) c FROM questions').get().c
  check('import-all 恢复成功', impRes.status === 302 && qCount === backupJson2.tables.questions.length)

  // 清理冒烟数据
  db.prepare("DELETE FROM redeem_orders WHERE order_no IN ('SMOKE001','SMOKE002','SMOKELOOK','SMOKESKIN')").run()
  db.prepare("DELETE FROM points_ledger WHERE user_id='u_smoke'").run()
  db.prepare("DELETE FROM votes WHERE user_id='u_smoke' OR question_id LIKE 'q_week_smoke_%'").run()
  db.prepare("DELETE FROM comment_likes WHERE comment_id IN ('cs0','cs1','cs2')").run()
  db.prepare("DELETE FROM comments WHERE id IN ('cs0','cs1','cs2')").run()
  db.prepare("DELETE FROM relook_draws WHERE user_id='u_smoke'").run()
  db.close()

  console.log('PASS:', ok.join('；'))
  if (bad.length) { console.log('FAIL:', bad.join('；')); process.exit(1) }
  console.log('全部通过')
}
main()
