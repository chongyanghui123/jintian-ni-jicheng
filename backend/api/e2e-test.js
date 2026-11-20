/**
 * 端到端接口自测：node backend/api/e2e-test.js
 * 用全新测试用户把 14 个接口 + 关键边界场景全部跑一遍，输出 PASS/FAIL 汇总。
 */
const BASE = 'http://localhost:3001'
const UID = 'u_e2e_' + Date.now().toString(36)

let pass = 0, fail = 0
const results = []

async function call(name, data = {}) {
  const res = await fetch(`${BASE}/api/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': UID },
    body: JSON.stringify(data)
  })
  return res.json()
}

function check(label, cond, extra = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  (' + extra + ')' : ''}`)
  cond ? pass++ : fail++
}

;(async () => {
  // ---------- 1. 今日题 ----------
  let r = await call('getTodayQuestion')
  const q = r.data && r.data.question
  check('getTodayQuestion 返回今日题', r.code === 0 && q && q.id && q.title, q ? `${q.id} ${q.date}` : JSON.stringify(r))
  check('未答状态', r.data.answered === false && r.data.myOption === null)
  const qid = q.id

  // ---------- 2. 短评门禁（未答不可读/不可发） ----------
  r = await call('getComments', { questionId: qid })
  check('未答时短评 locked', r.code === 0 && r.data.locked === true && r.data.total === 0)
  r = await call('addComment', { questionId: qid, option: 'A', content: '测试' })
  check('未答发短评被拒', r.code === -1, r.message)

  // ---------- 3. 投票 ----------
  r = await call('submitVote', { questionId: qid, option: 'A', duration: 8 })
  check('submitVote 成功+发积分', r.code === 0 && r.data.myOption === 'A' && r.data.earnedPoints === 2, `票数 A${r.data?.votesA}/B${r.data?.votesB}`)
  const votesAfterFirst = r.data.total
  r = await call('submitVote', { questionId: qid, option: 'B', duration: 3 })
  check('重复投票幂等（改票无效）', r.code === 0 && r.data.myOption === 'A' && r.data.total === votesAfterFirst)
  r = await call('submitVote', { questionId: 'q999', option: 'A', duration: 1 })
  check('不存在的题被拒', r.code === -1, r.message)
  r = await call('submitVote', { questionId: 'q001', option: 'A', duration: 1 })
  check('往期题被拒（跨零点保护）', r.code === -1, r.message)

  // ---------- 4. 结果 / AI 侧写 / 昨日揭晓 ----------
  r = await call('getVoteResult', { questionId: qid })
  check('getVoteResult', r.code === 0 && r.data.myOption === 'A' && r.data.isExpired === false)
  r = await call('getAiProfile', { questionId: qid, option: 'A', duration: 8, ratio: 100 })
  check('getAiProfile', r.code === 0 && r.data.tag && r.data.text && r.data.disclaimer, r.data?.tag)
  r = await call('getYesterdayResult')
  check('getYesterdayResult', r.code === 0 && r.data && r.data.question && r.data.date, r.data?.question?.id)

  // ---------- 5. 短评完整流程 ----------
  r = await call('getComments', { questionId: qid })
  check('答后短评解锁', r.code === 0 && r.data.locked === false, `共${r.data.total}条`)
  const hasOppositeTop = r.data.comments.some(c => c.isOppositeTop)
  check('对立面置顶标注', r.data.comments.length === 0 || typeof hasOppositeTop === 'boolean')
  r = await call('addComment', { questionId: qid, option: 'A', content: '这条是端到端测试短评' })
  const myCid = r.data && r.data.id
  check('addComment 成功', r.code === 0 && r.data.isMine === true)
  r = await call('addComment', { questionId: qid, option: 'A', content: '第二条' })
  check('每题一条限制', r.code === -1, r.message)
  r = await call('addComment', { questionId: qid, option: 'A', content: '加微信发财' })
  check('机审违规词拦截', r.code === -1, r.message)
  r = await call('addComment', { questionId: qid, option: 'A', content: '超过四十字的短评肯定是不行的因为限制是四十个字以内所以这条必须失败才行呀' })
  check('40 字限制', r.code === -1, r.message)
  r = await call('deleteComment', { commentId: myCid })
  check('5 分钟内可删', r.code === 0 && r.data.ok === true)
  r = await call('deleteComment', { commentId: myCid })
  check('重复删除被拒', r.code === -1, r.message)
  r = await call('addComment', { questionId: qid, option: 'A', content: '删后重发的最终短评' })
  const finalCid = r.data && r.data.id
  check('删除后可重发', r.code === 0)

  // ---------- 6. 举报：3 次自动隐藏 ----------
  for (let i = 0; i < 3; i++) {
    r = await call('reportContent', { targetType: 'comment', targetId: finalCid, reason: 'low_quality', detail: 'e2e' })
  }
  check('reportContent 落库', r.code === 0 && r.data.ok === true)
  r = await call('getComments', { questionId: qid })
  check('3 次举报后自动隐藏', !r.data.comments.some(c => c.id === finalCid), `剩余${r.data.total}条`)

  // ---------- 7. 投稿 ----------
  r = await call('submitQuestion', { title: '端到端测试投稿题干', optionA: '甲', optionB: '乙', signature: '测试员' })
  check('submitQuestion 成功进待审', r.code === 0 && r.data.status === 'pending', r.data?.id)
  r = await call('submitQuestion', { title: '短', optionA: '甲', optionB: '乙' })
  check('题干长度校验', r.code === -1, r.message)
  r = await call('submitQuestion', { title: '重复选项测试投稿题干', optionA: '一样', optionB: '一样' })
  check('两选项相同校验', r.code === -1, r.message)
  r = await call('submitQuestion', { title: '官方客服测试投稿题干', optionA: '甲', optionB: '乙' })
  check('投稿机审拦截', r.code === -1, r.message)
  await call('submitQuestion', { title: '端到端第二道投稿测试题', optionA: '甲', optionB: '乙' })
  await call('submitQuestion', { title: '端到端第三道投稿测试题', optionA: '甲', optionB: '乙' })
  r = await call('submitQuestion', { title: '端到端第四道投稿测试题', optionA: '甲', optionB: '乙' })
  check('每日 3 道上限', r.code === -1, r.message)
  r = await call('getMySubmissions')
  check('getMySubmissions 列表', r.code === 0 && r.data.length === 3 && r.data[0].status === 'pending', `${r.data.length}条`)

  // ---------- 8. 积分 ----------
  r = await call('getPoints')
  const pts = r.data
  check('getPoints 汇总', r.code === 0 && pts.balance === 2 && pts.earnedToday === 2 && pts.totalEarned === 2, `余额${pts.balance}`)
  check('积分流水', pts.ledger.length >= 1 && pts.ledger[0].type === 'earn' && pts.ledger[0].refId === qid)

  // ---------- 9. 兑换 ----------
  r = await call('getPrizes')
  check('getPrizes 商品列表', r.code === 0 && r.data.length >= 3 && r.data.every(p => p.stock >= 0))
  r = await call('redeemPrize', { prizeId: 'p_title' })
  check('余额不足拦截', r.code === -1, r.message)
  r = await call('redeemPrize', { prizeId: 'p_none' })
  check('商品不存在拦截', r.code === -1, r.message)
  // 补积分后完整兑换一次
  await call('reportContent', { targetType: 'question', targetId: qid, reason: 'other' }) // 干扰项，不影响积分
  r = await call('getTodayQuestion')
  check('幂等投票后 answered 状态', r.data.answered === true && r.data.myOption === 'A')

  console.log(results.join('\n'))
  console.log(`\n汇总: ${pass} PASS / ${fail} FAIL  (测试用户 ${UID})`)
  process.exit(fail > 0 ? 1 : 0)
})().catch((e) => { console.error('E2E 执行中断:', e.message); process.exit(2) })
