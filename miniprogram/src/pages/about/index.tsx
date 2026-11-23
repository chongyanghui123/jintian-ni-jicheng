import React from 'react'
import { View, Text } from '@tarojs/components'
import styles from './index.module.scss'

/** 隐私说明与免责声明：内容需与小程序实际收集范围保持一致（2026-11-23） */
const UPDATED_AT = '2026-11-23'

const SECTIONS: { title: string; items: string[] }[] = [
  {
    title: '一、我们收集哪些信息',
    items: [
      '微信登录标识（openid）：进入小程序时会静默登录，用于区分账号、保证每人每天一票，并把答题记录与积分归到你名下。',
      '头像与昵称：只有你在「我的」页主动点击授权时才会获取，仅用于页面展示；不授权也能正常答题。',
      '答题与互动数据：你选择的选项、决策时长、短评、投稿与举报内容，用于统计占比、发放积分、内容审核和风控。',
      '本机缓存：设备本地会保存登录标识、答题记录与已读状态，清除小程序缓存即可删除。',
      '我们不收集：手机号、地理位置、通讯录、相册（仅在你主动选择头像时读取你选中的那一张图片）。'
    ]
  },
  {
    title: '二、信息如何使用',
    items: [
      '统计每日投票占比、连续答题天数、积分与兑换进度；',
      '识别异常刷票、恶意投稿与违规内容；',
      '在你答过题后生成「AI 侧写」，连答满 7 天后生成本周人格报告；',
      '我们不会把你的信息用于广告定向投放，也不会出售或出租给任何第三方。'
    ]
  },
  {
    title: '三、存储与安全',
    items: [
      '数据存储在中国境内的服务器，仅运营人员通过受控后台访问；',
      '后台访问需要管理密码，对外只开放必要的 HTTPS 接口；',
      '数据在实现上述目的所需的期限内保留，超出期限后删除或匿名化处理。'
    ]
  },
  {
    title: '四、第三方服务',
    items: [
      '微信登录与开放能力（腾讯）：用于身份识别、分享以及头像昵称填写；',
      '大模型服务：生成 AI 侧写/周报时，只发送题目内容、你的选择、决策时长和匿名占比，不发送你的微信标识、头像或昵称。'
    ]
  },
  {
    title: '五、你的权利',
    items: [
      '撤回授权：微信「最近使用的小程序」→ 右上角「···」→ 设置，可关闭头像昵称授权；',
      '撤回短评：发布后 5 分钟内在结果页可自行删除；',
      '删除数据与注销：通过「我的 → 举报反馈」提交「申请删除个人数据」，我们核实后在 7 个工作日内处理；',
      '未成年人：请在监护人指导下使用；监护人可联系我们删除相关数据。'
    ]
  },
  {
    title: '六、内容与免责声明',
    items: [
      '题目由运营编排或用户投稿（经人工审核后上线），每日一题、当天不变；',
      '占比数据来自真实投票统计，不做修饰；样本较少时结果仅供参考；',
      '短评仅代表发布者个人观点，不代表本产品立场；发现不当内容可在结果页举报，我们会核实处理；',
      'AI 侧写与周报由算法生成，仅供娱乐，不构成心理、医疗、法律或投资建议；',
      '本产品不设置诱导分享、连击挽留、限时抢兑等机制。'
    ]
  },
  {
    title: '七、说明更新',
    items: [
      '功能调整时我们可能更新本说明，更新后会在本页公示并同步修改更新日期；',
      '对本说明有疑问，可通过「我的 → 举报反馈」联系我们。'
    ]
  }
]

const AboutPage: React.FC = () => {
  return (
    <View className={styles.page}>
      <Text className={styles.title}>隐私说明与免责声明</Text>
      <Text className={styles.meta}>更新日期：{UPDATED_AT} · 适用版本 V1.0</Text>
      <Text className={styles.intro}>
        「今天你几成」是一款每日同题投票小程序。我们尽量少收集信息，下面说明清楚收集了什么、怎么用、存在哪里。
      </Text>

      {SECTIONS.map((section) => (
        <View key={section.title} className={styles.card}>
          <Text className={styles.sectionTitle}>{section.title}</Text>
          {section.items.map((item) => (
            <View key={item} className={styles.itemRow}>
              <Text className={styles.itemDot}>·</Text>
              <Text className={styles.itemText}>{item}</Text>
            </View>
          ))}
        </View>
      ))}

      <Text className={styles.footer}>今天你几成 · 更新于 {UPDATED_AT}</Text>
    </View>
  )
}

export default AboutPage
