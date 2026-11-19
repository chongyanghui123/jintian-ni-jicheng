import type { Question } from '@/types'

/**
 * 内置题库（MVP 供给主干，365 天不重复的目标由云上 questions 集合排期实现，
 * 本题库同时作为 H5 mock 数据源，按日期轮换）。
 */
export const QUESTIONS: Question[] = [
  { id: 'q001', title: '闹钟响了就起，还是再睡十分钟？', optionA: '响了就起', optionB: '再睡十分钟', date: '' },
  { id: 'q002', title: '双休但工资少一千，和单休多一千，你选哪个？', optionA: '双休少一千', optionB: '单休多一千', date: '' },
  { id: 'q003', title: '领导把不是你的锅甩给你，当场解释还是私下再说？', optionA: '当场解释', optionB: '私下再说', date: '' },
  { id: 'q004', title: '同事摸鱼被你撞见，你会装没看见吗？', optionA: '会，各自安好', optionB: '不会，看不下去', date: '' },
  { id: 'q005', title: '工作消息已读不回，算不算失礼？', optionA: '算', optionB: '不算', date: '' },
  { id: 'q006', title: '一杯 30 的奶茶和三杯 10 的，你选哪个？', optionA: '30 的一杯', optionB: '10 的三杯', date: '' },
  { id: 'q007', title: '购物车放了一年的东西，你最后买了吗？', optionA: '还是买了', optionB: '删了', date: '' },
  { id: 'q008', title: '外卖凑满减，你会多点一份凑单吗？', optionA: '会凑', optionB: '不凑', date: '' },
  { id: 'q009', title: '看视频遇到广告，你选择等还是花钱跳过？', optionA: '等着', optionB: '花钱跳过', date: '' },
  { id: 'q010', title: '换新手机后，旧手机你怎么处理？', optionA: '闲置吃灰', optionB: '转手卖掉', date: '' },
  { id: 'q011', title: '伴侣手机弹了暧昧消息，你会假装没看见吗？', optionA: '先装没看见', optionB: '直接问', date: '' },
  { id: 'q012', title: '朋友每次都迟到半小时，你还约他吗？', optionA: '还约', optionB: '不约了', date: '' },
  { id: 'q013', title: '相亲对象条件很好但你没感觉，再见一面吗？', optionA: '再见一面', optionB: '算了', date: '' },
  { id: 'q014', title: '群里有人发砍价链接，你会帮砍吗？', optionA: '帮一刀', optionB: '装没看见', date: '' },
  { id: 'q015', title: '朋友借钱不还但金额不大，你会开口要吗？', optionA: '开口要', optionB: '算了不提', date: '' },
  { id: 'q016', title: '地上捡到 100 块，四下无人，你交吗？', optionA: '交给警察', optionB: '自己收下', date: '' },
  { id: 'q017', title: '排队有人插队，你会出声吗？', optionA: '会出声', optionB: '忍了', date: '' },
  { id: 'q018', title: '自助餐偷偷打包，算不算偷？', optionA: '算', optionB: '不算', date: '' },
  { id: 'q019', title: '看到朋友对象和别人暧昧，你会告诉朋友吗？', optionA: '会告诉', optionB: '不掺和', date: '' },
  { id: 'q020', title: '电影院后排有人大声打电话，你会提醒吗？', optionA: '会提醒', optionB: '忍了', date: '' },
  { id: 'q021', title: '夏天空调，26 度还是 22 度？', optionA: '26 度', optionB: '22 度', date: '' },
  { id: 'q022', title: '吃火锅蘸料，麻酱派还是油碟派？', optionA: '麻酱', optionB: '油碟', date: '' },
  { id: 'q023', title: '甜豆腐脑和咸豆腐脑，你站哪边？', optionA: '甜的', optionB: '咸的', date: '' },
  { id: 'q024', title: '周末睡到自然醒，还是定闹钟过有计划的一天？', optionA: '自然醒', optionB: '定闹钟', date: '' },
  { id: 'q025', title: '猫和狗只能养一个，你养哪个？', optionA: '猫', optionB: '狗', date: '' },
  { id: 'q026', title: '如果明天不上班也没工资，你还会早起吗？', optionA: '会', optionB: '不会', date: '' },
  { id: 'q027', title: '你觉得自己是熬夜的受害者，还是受益者？', optionA: '受害者', optionB: '受益者', date: '' },
  { id: 'q028', title: '十年后你会后悔现在没多陪父母吗？', optionA: '会', optionB: '不会', date: '' },
  { id: 'q029', title: '如果能重来一次高考，你会更努力吗？', optionA: '会更努力', optionB: '不会', date: '' },
  { id: 'q030', title: '你上一次说"改天约"，是真的想约吗？', optionA: '真想约', optionB: '客套话', date: '' }
]

/** 字符串 hash（mock 票数与日期轮换的确定性种子） */
export function hashString(s: string): number {
  let seed = 0
  for (let i = 0; i < s.length; i++) {
    seed = (seed * 31 + s.charCodeAt(i)) % 9973
  }
  return seed
}

/** 按日期轮换取题（mock 口径：与云上按 showDate 排期同语义） */
export function getQuestionByDate(date: string): Question {
  const idx = hashString(date) % QUESTIONS.length
  const q = QUESTIONS[idx]
  return { ...q, date }
}

/** mock 票数：同一天同一题全端一致，范围 8~300，天然覆盖"样本不足"场景 */
export function mockVotesFor(questionId: string): { votesA: number; votesB: number } {
  const seed = hashString(questionId)
  const total = 8 + (seed % 292)
  const aRatio = 15 + (seed % 71) // 15% ~ 85%
  const votesA = Math.round((total * aRatio) / 100)
  return { votesA, votesB: total - votesA }
}
