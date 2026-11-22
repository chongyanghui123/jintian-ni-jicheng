/**
 * 订阅消息配置
 * 模板 ID 获取：微信公众平台 → 功能 → 订阅消息 → 我的模板，
 * 申请「一次性订阅」类型的新题提醒模板后，把模板 ID 填到 SUBSCRIBE_TMPL_ID。
 * 留空时小程序端完全静默（不弹授权窗），云函数下发侧也会跳过。
 */
export const SUBSCRIBE_TMPL_ID = ''

/**
 * 云开发环境 ID（部署开关）
 * - 留空 = 本地开发模式：所有接口走 http://localhost:3001（backend/api/server.js）
 * - 填写 = 部署模式：所有接口走微信云开发云函数（wx.cloud.callFunction），身份为 OPENID
 * 部署时在微信开发者工具 → 云开发控制台复制环境 ID 填到这里。
 */
export const CLOUD_ENV = ''
