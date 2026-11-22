/**
 * 订阅消息配置
 * 模板 ID 获取：微信公众平台 → 功能 → 订阅消息 → 我的模板，
 * 申请「一次性订阅」类型的新题提醒模板后，把模板 ID 填到 SUBSCRIBE_TMPL_ID。
 * 留空时小程序端完全静默（不弹授权窗），云函数下发侧也会跳过。
 */
export const SUBSCRIBE_TMPL_ID = ''
