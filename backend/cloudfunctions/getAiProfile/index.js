const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

/**
 * AI 侧写（MVP 用模板库，不调大模型）：
 * 固定标签池（四到六字）+ 30-60 字文案 + 固定免责。
 * 边界（文档 3.5）：不做人格定型，不用"回避型""讨好型"类词，不给建议。
 */
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

exports.main = async (event) => {
  try {
    const { questionId, option, duration, ratio } = event
    if (!questionId || (option !== 'A' && option !== 'B')) {
      return { code: -1, message: '参数错误', data: null }
    }
    const key = `${bandOf(duration || 0)}-${crowdOf(typeof ratio === 'number' ? ratio : -1)}`
    const tag = TAGS[key] || '随心一拍'
    const pool = TEXTS[key] || TEXTS['fast-even']
    const text = pool[hashString(`${questionId}-${option}`) % pool.length]
    console.info('[getAiProfile]', key, tag)
    return { code: 0, message: 'success', data: { tag, text, disclaimer: DISCLAIMER } }
  } catch (err) {
    console.error('[getAiProfile] error:', err)
    return { code: -1, message: err.message || '服务异常', data: null }
  }
}
