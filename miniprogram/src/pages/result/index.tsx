import React, { useEffect, useRef, useState } from 'react'
import { View, Text, Input } from '@tarojs/components'
import Taro, { useRouter, useShareAppMessage, useShareTimeline } from '@tarojs/taro'
import type { AiProfile, CommentItem, CommentsData, VoteResultData } from '@/types'
import { api } from '@/services/api'
import { getRecordById, optionRatio } from '@/services/storage'
import shareCard from '@/assets/share-card.jpg'
import ProfileCard from '@/components/ProfileCard'
import RatioBar from '@/components/RatioBar'
import SharePanel from '@/components/SharePanel'
import ReportSheet from '@/components/ReportSheet'
import styles from './index.module.scss'

/** 样本不足阈值：票数不到 30 不写占比，数字太小不可信也接近泄露个人选择 */
const MIN_SAMPLE = 30

const ResultPage: React.FC = () => {
  const router = useRouter()
  const questionId = router.params.questionId || ''
  const fromReveal = router.params.from === 'reveal'

  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<VoteResultData | null>(null)
  const [profile, setProfile] = useState<AiProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [reportVisible, setReportVisible] = useState(false)
  // 短评状态（对应文档 4.3：答过才能读，默认 3 条可展开；每页 20 条可加载更多）
  const [comments, setComments] = useState<CommentsData | null>(null)
  const [commentsExpanded, setCommentsExpanded] = useState(false)
  const [commentsLoadingMore, setCommentsLoadingMore] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [commentBusy, setCommentBusy] = useState(false)
  // 限定皮肤「夜航」：兑换 p_skin 后 30 天内，结果页切专属配色
  const [nightSkin, setNightSkin] = useState(false)

  /** 分享标题需在 useShareAppMessage 回调里实时取，用 ref 存最新值 */
  const shareTitleRef = useRef('今天这题有点难选，你来')

  useShareAppMessage(() => ({
    title: shareTitleRef.current,
    path: `/pages/result/index?questionId=${questionId}`,
    imageUrl: shareCard
  }))
  useShareTimeline(() => ({
    title: shareTitleRef.current,
    query: `questionId=${questionId}`,
    imageUrl: shareCard
  }))

  useEffect(() => {
    if (!questionId) {
      console.error('[Result] missing questionId')
      setLoading(false)
      return
    }
    const load = async () => {
      try {
        const res = await api.getVoteResult(questionId)
        setData(res)
        // 皮肤状态：兑换「夜航」30 天内生效（失败静默，不影响主流程）
        api.getPoints().then((p) => setNightSkin(!!p.skin?.active)).catch(() => {})
        // 侧写只在"我答过这题"时生成（被分享进入无我的选择）
        const record = getRecordById(questionId)
        if (record && res.myOption) {
          setProfileLoading(true)
          const myPct = optionRatio(res.votesA, res.votesB, res.myOption)
          try {
            const p = await api.getAiProfile({
              questionId,
              option: res.myOption,
              duration: record.duration,
              ratio: res.total >= 10 ? myPct : -1,
              title: res.question?.title,
              optionA: res.question?.optionA,
              optionB: res.question?.optionB
            })
            setProfile(p)
          } catch (err) {
            console.error('[Result] getAiProfile failed:', err)
          } finally {
            setProfileLoading(false)
          }
        }
      } catch (err) {
        console.error('[Result] getVoteResult failed:', err)
        Taro.showToast({ title: '加载失败', icon: 'none' })
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [questionId])

  // 短评：拿到我的选择后加载（服务端门禁：未答 locked；offset 分页）
  const loadComments = (offset = 0) => {
    api
      .getComments({ questionId, myOption: data?.myOption ?? null, offset })
      .then((res) => {
        setComments((prev) => {
          if (offset > 0 && prev && !prev.locked) {
            // 追加去重（对面置顶题只在第一页出现，不会重叠）
            const seen = new Set(prev.comments.map((c) => c.id))
            return { ...res, comments: [...prev.comments, ...res.comments.filter((c) => !seen.has(c.id))] }
          }
          return res
        })
      })
      .catch((err) => console.error('[Result] getComments failed:', err))
  }

  useEffect(() => {
    if (!data || !data.question) return
    loadComments(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionId, data])

  /** 加载更多短评（每页 20 条） */
  const handleLoadMoreComments = () => {
    if (commentsLoadingMore || !comments) return
    setCommentsLoadingMore(true)
    api
      .getComments({ questionId, myOption: data?.myOption ?? null, offset: comments.comments.length })
      .then((res) => {
        setComments((prev) => {
          if (!prev || prev.locked) return res
          const seen = new Set(prev.comments.map((c) => c.id))
          return { ...res, comments: [...prev.comments, ...res.comments.filter((c) => !seen.has(c.id))] }
        })
      })
      .catch((err) => Taro.showToast({ title: err.message || '加载失败', icon: 'none' }))
      .finally(() => setCommentsLoadingMore(false))
  }

  /** 发短评（每人每题一条；发后刷新） */
  const handleAddComment = () => {
    if (commentBusy || !data?.myOption) return
    const text = commentText.trim()
    if (!text) {
      Taro.showToast({ title: '写点什么再发', icon: 'none' })
      return
    }
    setCommentBusy(true)
    api
      .addComment({ questionId, option: data.myOption, content: text })
      .then(() => api.getComments({ questionId, myOption: data.myOption }))
      .then((res) => {
        setComments(res)
        setCommentsExpanded(false)
        setCommentText('')
        Taro.showToast({ title: '已发布', icon: 'success' })
      })
      .catch((err) => Taro.showToast({ title: err.message || '发布失败', icon: 'none' }))
      .finally(() => setCommentBusy(false))
  }

  /** 删自己的短评（5 分钟内） */
  const handleDeleteComment = () => {
    const mine = comments?.mine
    if (!mine) return
    Taro.showModal({
      title: '撤回短评',
      content: '删除后不可恢复，也不可再改。确定撤回？',
      success: (res) => {
        if (!res.confirm) return
        api
          .deleteComment(mine.id)
          .then(() => api.getComments({ questionId, myOption: data?.myOption }))
          .then(setComments)
          .catch((err) => Taro.showToast({ title: err.message || '删除失败', icon: 'none' }))
      }
    })
  }

  /** 举报短评 */
  const handleReportComment = (commentId: string) => {
    api
      .reportContent({ targetType: 'comment', targetId: commentId, reason: 'inappropriate' })
      .then(() => Taro.showToast({ title: '已举报，累计 3 次将自动隐藏', icon: 'none' }))
      .catch((err) => Taro.showToast({ title: err.message || '举报失败', icon: 'none' }))
  }

  /** 短评点赞 toggle（服务端幂等，返回最新点赞数） */
  const handleLikeComment = (commentId: string) => {
    api
      .likeComment(commentId)
      .then((res) => {
        setComments((prev) => {
          if (!prev || prev.locked) return prev
          const patch = (c: CommentItem) =>
            c.id === res.commentId ? { ...c, likes: res.likes, isLiked: res.liked } : c
          return {
            ...prev,
            comments: prev.comments.map(patch),
            mine: prev.mine ? patch(prev.mine) : prev.mine
          }
        })
      })
      .catch((err) => Taro.showToast({ title: err.message || '点赞失败', icon: 'none' }))
  }

  // 分享标题模板：样本不足 → 少数派 → 多数派（单一路径，从上往下命中即止）
  const computeShareTitle = (): string => {
    if (!data || !data.question) return '今天这题有点难选，你来'
    const { votesA, votesB, total, myOption, question } = data
    if (total < MIN_SAMPLE) return '今天这题有点难选，你来'
    if (myOption) {
      const myPct = optionRatio(votesA, votesB, myOption)
      if (myPct >= 50) return `这题 ${myPct}% 的人和我选一样`
      const optionText = myOption === 'A' ? question.optionA : question.optionB
      return `这题只有 ${myPct}% 的人选了「${optionText}」，你是哪种`
    }
    const pctA = optionRatio(votesA, votesB, 'A')
    return `这题 ${pctA}% 的人选了「${question.optionA}」，你是哪种`
  }

  const shareTitle = computeShareTitle()
  shareTitleRef.current = shareTitle

  // 人群判定（占比真实可核对）
  const getCrowd = (): { label: string; cls: string } | null => {
    if (!data || !data.myOption || data.total < MIN_SAMPLE) return null
    const pct = optionRatio(data.votesA, data.votesB, data.myOption)
    if (pct >= 60) return { label: '多数派', cls: styles.crowdMajor }
    if (pct <= 40) return { label: '少数派', cls: styles.crowdMinor }
    return { label: '势均力敌', cls: styles.crowdEven }
  }

  // 返回：页面栈有上一页则返回，分享直接打开（栈只有一层）时回首页
  const goBack = () => {
    const pages = Taro.getCurrentPages()
    if (pages.length > 1) {
      Taro.navigateBack({ delta: 1 })
    } else {
      Taro.switchTab({ url: '/pages/today/index' })
    }
  }

  if (loading) {
    return (
      <View className={styles.page}>
        <View className={styles.backLink} onClick={goBack}>
          <Text>← 返回</Text>
        </View>
        <View className={styles.actionCard}>
          <View className={styles.dotsRow}>
            <View className={styles.dot} />
            <View className={styles.dot} />
            <View className={styles.dot} />
          </View>
          <Text className={styles.actionText}>正在开票</Text>
        </View>
      </View>
    )
  }

  if (!data || !data.question) {
    return (
      <View className={styles.page}>
        <View className={styles.backLink} onClick={goBack}>
          <Text>← 返回</Text>
        </View>
        <View className={styles.actionCard}>
          <Text className={styles.actionEmoji}>🫥</Text>
          <Text className={styles.actionText}>这道题不存在或已下架</Text>
          <View className={styles.goTodayBtn} onClick={() => Taro.switchTab({ url: '/pages/today/index' })}>
            去看今天这题
          </View>
        </View>
      </View>
    )
  }

  const { question, votesA, votesB, total, myOption, isExpired } = data
  const crowd = getCrowd()

  return (
    <View className={`${styles.page} ${nightSkin ? styles.pageNight : ''}`}>
      <View className={styles.backLink} onClick={goBack}>
        <Text>← 返回</Text>
      </View>
      <View className={styles.questionCard}>
        <View className={styles.reportLink} onClick={() => setReportVisible(true)}>
          <Text>举报</Text>
        </View>
        <Text className={styles.questionTitle}>{question.title}</Text>
        <View className={styles.optionRow}>
          <Text className={styles.optionText}>A · {question.optionA}</Text>
          {myOption === 'A' && <Text className={styles.myMark}>你选的</Text>}
        </View>
        <View className={styles.optionRow}>
          <Text className={styles.optionText}>B · {question.optionB}</Text>
          {myOption === 'B' && <Text className={styles.myMark}>你选的</Text>}
        </View>
      </View>

      {fromReveal && <Text className={styles.expiredTip}>这是昨天那道题的最终结果</Text>}

      <ProfileCard profile={profile} loading={profileLoading} />

      <View className={styles.crowdCard}>
        <View className={styles.crowdRow}>
          <Text className={styles.crowdTitle}>
            {myOption ? '你站的是' : '目前战况'}
          </Text>
          {crowd && <Text className={`${styles.crowdTag} ${crowd.cls}`}>{crowd.label}</Text>}
        </View>
        <RatioBar
          votesA={votesA}
          votesB={votesB}
          total={total}
          showPercent={total >= MIN_SAMPLE}
        />
        {total < MIN_SAMPLE && (
          <Text className={styles.expiredTip}>
            样本还在积累，占比暂不公开——你是今天最早的一批人
          </Text>
        )}
        {isExpired && <Text className={styles.expiredTip}>这道题已经结束，明天来看新的</Text>}
      </View>

      {myOption ? (
        <SharePanel shareTitle={shareTitle} />
      ) : (
        <View className={styles.actionCard}>
          <Text className={styles.actionEmoji}>🤔</Text>
          <Text className={styles.actionText}>
            {isExpired ? '这道题已经结束，去答今天的' : '还没作答，你的选择会改变这条横条'}
          </Text>
          <View className={styles.goTodayBtn} onClick={() => Taro.switchTab({ url: '/pages/today/index' })}>
            去答今天这题
          </View>
        </View>
      )}

      {/* 短评区：答过才能读（服务端门禁）；只标 A/B，无昵称头像；不能回复/@/点赞 */}
      {myOption && comments && !comments.locked && (
        <View className={styles.commentsCard}>
          <View className={styles.commentsHeader}>
            <Text className={styles.commentsTitle}>大家的理由</Text>
            <Text className={styles.commentsHint}>只标 A/B · 每题一条 · 点赞高的排前面</Text>
          </View>

          {comments.mine && (
            <View className={styles.commentItem}>
              <View className={styles.commentMeta}>
                <Text
                  className={`${styles.commentBadge} ${
                    comments.mine.option === 'A' ? styles.badgeA : styles.badgeB
                  }`}
                >
                  {comments.mine.option}
                </Text>
                <Text className={styles.youMark}>你</Text>
                <View className={styles.commentActions}>
                  <Text
                    className={`${styles.likeBtn} ${comments.mine.isLiked ? styles.likeBtnActive : ''}`}
                    onClick={() => handleLikeComment(comments.mine!.id)}
                  >
                    {comments.mine.isLiked ? '♥' : '♡'} {comments.mine.likes || 0}
                  </Text>
                  <Text className={styles.commentAction} onClick={handleDeleteComment}>
                    撤回
                  </Text>
                </View>
              </View>
              <Text className={styles.commentContent}>{comments.mine.content}</Text>
            </View>
          )}

          {comments.comments.slice(0, commentsExpanded ? comments.comments.length : 3).map((c) => (
            <View key={c.id} className={styles.commentItem}>
              <View className={styles.commentMeta}>
                {c.isOppositeTop && <Text className={styles.oppositeTag}>对面的理由</Text>}
                <Text
                  className={`${styles.commentBadge} ${c.option === 'A' ? styles.badgeA : styles.badgeB}`}
                >
                  {c.option}
                </Text>
                <View className={styles.commentActions}>
                  <Text
                    className={`${styles.likeBtn} ${c.isLiked ? styles.likeBtnActive : ''}`}
                    onClick={() => handleLikeComment(c.id)}
                  >
                    {c.isLiked ? '♥' : '♡'} {c.likes || 0}
                  </Text>
                  <Text className={styles.commentAction} onClick={() => handleReportComment(c.id)}>
                    举报
                  </Text>
                </View>
              </View>
              <Text className={styles.commentContent}>{c.content}</Text>
            </View>
          ))}

          {comments.total > 3 && !commentsExpanded && (
            <View className={styles.expandBtn} onClick={() => setCommentsExpanded(true)}>
              展开全部 {comments.total} 条
            </View>
          )}

          {commentsExpanded && comments.hasMore && (
            <View className={styles.expandBtn} onClick={handleLoadMoreComments}>
              {commentsLoadingMore ? '加载中…' : '加载更多'}
            </View>
          )}

          {comments.total === 0 && !comments.mine && (
            <Text className={styles.commentsEmpty}>还没有人写短评，你可以是第一个</Text>
          )}

          {!comments.mine && (
            <View className={styles.commentInputRow}>
              <Input
                className={styles.commentInput}
                value={commentText}
                maxlength={40}
                confirmType='send'
                onConfirm={handleAddComment}
                placeholderClass='input-ph'
                placeholder={comments.mine ? '' : '一句话说你的理由（40 字内）'}
                onInput={(e) => setCommentText(e.detail.value)}
              />
              <View className={styles.commentSendBtn} onClick={handleAddComment}>
                发送
              </View>
            </View>
          )}
          {comments.mine && (
            <Text className={styles.commentsHint}>你已经写过这题的短评（发布 5 分钟内可撤回）</Text>
          )}
        </View>
      )}
      {myOption && comments && comments.locked && (
        <View className={styles.commentsCard}>
          <Text className={styles.commentsEmpty}>答完这题才能看大家的理由</Text>
        </View>
      )}

      <ReportSheet
        visible={reportVisible}
        targetType='question'
        targetId={question.id}
        onClose={() => setReportVisible(false)}
      />
    </View>
  )
}

export default ResultPage
