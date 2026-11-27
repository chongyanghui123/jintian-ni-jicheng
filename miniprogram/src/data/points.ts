/**
 * 积分规则（本地预览兜底）：
 * 答完题同时发放积分与转盘抽奖次数；实际数值以后台「积分规则」「运营设置」为准。
 */
export const POINTS_RULES = {
  /** 每日答题 */
  ANSWER: 2,
  /** 连续答题满 7 天奖励 */
  STREAK7: 10,
  /** 单日获取上限（保护值） */
  DAILY_CAP: 60
}

export interface PrizeDef {
  id: string
  name: string
  desc: string
  /** 本地 mock 无商品图：留空走文字卡片 */
  image: string
  cost: number
  stock: number
  monthlyLimit: number
}

/**
 * 首期 3 个虚拟品（对应文档 6.3：首期只上 3 个虚拟品；
 * 文档中的"加更权"与全站同题规则冲突，按 V1.7 修订换成往期回看券）。
 */
export const DEFAULT_PRIZES: PrizeDef[] = [
  {
    id: 'p_title',
    name: '专属称号「清醒人」',
    desc: '展示在「我的」页面，仅答过题的人能懂',
    image: '',
    cost: 100,
    stock: 100,
    monthlyLimit: 1
  },
  {
    id: 'p_relook',
    name: '往期回看券',
    desc: '解锁一道往期题的完整结果与占比',
    image: '',
    cost: 200,
    stock: 50,
    monthlyLimit: 1
  },
  {
    id: 'p_skin',
    name: '限定皮肤「夜航」',
    desc: '结果页专属配色，30 天',
    image: '',
    cost: 300,
    stock: 20,
    monthlyLimit: 1
  }
]
