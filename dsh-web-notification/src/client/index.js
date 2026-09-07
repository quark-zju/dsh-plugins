/**
 * dsh-web-notification —— 客户端插件（浏览器端）
 *
 * 监听所有已打开会话（snapshot.openState === 'open'）的轮次完成：
 * turnEnds（Map<turn, endSeq>）中最大 turn 增长，即该会话完成了一轮回复，
 * 随即弹出系统通知。多会话并行回复时各自独立触发，不依赖任何 UI 挂载。
 *
 * 每条通知使用唯一 tag（dsh-reply-done-<sessionId>-<turn>）+ renotify，
 * 互不替换，保证每轮回复都弹出。
 *
 * 由 build.mjs 包装为 ModuleLoader 工厂握手格式 → lib/client.js。
 */

module.exports = {
  inject: ['sessions'],

  apply(ctx) {
    const supported = typeof Notification !== 'undefined'
    const sessions = ctx.get('sessions')

    // 同一轮回复只弹一次（防止快照刷新导致的重复触发）。
    const lastNotifiedAt = new Map()

    // 最大已完成轮数：取 turnEnds 键的最大值。
    function maxTurnOf(snapshot) {
      try {
        const ends = snapshot && snapshot.turnEnds
        let max = 0
        if (ends && typeof ends.keys === 'function') {
          for (const t of ends.keys()) if (t > max) max = t
        }
        return max
      } catch (e) {
        return 0
      }
    }

    // 触发本轮回复的用户消息文本：优先匹配指定 turn 的用户节点，
    // 匹配不到则回退到最近一条用户消息；都没有时返回空串。
    function latestUserTextOf(snapshot, turn) {
      try {
        const chat = snapshot && snapshot.chat
        const order = chat && chat.order
        const nodes = chat && chat.nodes
        if (!order || !nodes || typeof nodes.get !== 'function') return ''
        for (let i = order.length - 1; i >= 0; i--) {
          const node = nodes.get(order[i])
          if (!node || node.kind !== 'user' || !node.data) continue
          const loc = node.location
          if (turn !== undefined && loc && typeof loc.turn === 'number' && loc.turn !== turn) continue
          const parts = node.data.content
          if (!Array.isArray(parts)) continue
          const text = parts
            .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join(' ')
          const trimmed = text.trim()
          if (trimmed !== '') return trimmed
        }
        return ''
      } catch (e) {
        return ''
      }
    }

    // 会话标题（用户消息不可用时的后备文案）。
    function titleOf(sessionId) {
      try {
        const byId = sessions && sessions.list && sessions.list.getSnapshot().byId
        return (byId && byId[sessionId] && byId[sessionId].displayTitle) || String(sessionId)
      } catch (e) {
        return String(sessionId)
      }
    }

    // 弹系统通知（权限未授予时跳过）。
    // label 为用户消息文本，缺失时回退到会话标题。
    function showNotification(sessionId, turn, label) {
      const dedupKey = String(sessionId) + '#' + String(turn)
      const now = Date.now()
      const last = lastNotifiedAt.get(dedupKey) || 0
      if (now - last < 2000) return
      lastNotifiedAt.set(dedupKey, now)
      if (lastNotifiedAt.size > 50) {
        for (const key of lastNotifiedAt.keys()) {
          lastNotifiedAt.delete(key)
          if (lastNotifiedAt.size <= 50) break
        }
      }
      if (!supported || Notification.permission !== 'granted') return
      try {
        const notification = new Notification('🐳 Model Replied', {
          body: label,
          // 唯一 tag：通知互不替换，每轮都能弹出。
          tag: 'dsh-reply-done-' + sessionId + '-' + turn,
          renotify: true,
        })
        notification.onclick = () => {
          try { window.focus() } catch (e) { /* ignore */ }
        }
      } catch (e) {
        console.error('dsh-web-notification: notification failed', e)
      }
    }

    // 请求通知权限：启动时一次 + 首次用户手势时一次（Safari 要求在
    // 手势内请求）。随插件卸载自动清理。
    ctx.effect(() => {
      if (!supported) return
      const request = () => {
        if (Notification.permission !== 'default') return
        try {
          const result = Notification.requestPermission()
          if (result && typeof result.then === 'function') {
            result.catch(() => { /* ignore */ })
          }
        } catch (e) {
          console.error('dsh-web-notification: permission request failed', e)
        }
      }
      request()
      const onGesture = () => {
        if (Notification.permission !== 'default') {
          window.removeEventListener('pointerdown', onGesture)
          window.removeEventListener('keydown', onGesture)
          return
        }
        request()
      }
      window.addEventListener('pointerdown', onGesture)
      window.addEventListener('keydown', onGesture)
      return () => {
        window.removeEventListener('pointerdown', onGesture)
        window.removeEventListener('keydown', onGesture)
      }
    }, 'dsh-web-notification: permission request')

    // 多会话监听：每个已打开会话独立记录基线轮次；
    // openState 变为 'open' 前只建基线、不通知（避免历史加载误报）。
    const watchers = new Map()

    function watchSession(sessionId) {
      if (watchers.has(sessionId)) return
      let session
      try {
        const binding = sessions && typeof sessions.binding === 'function' ? sessions.binding(sessionId) : undefined
        session = binding && binding.session
      } catch (e) {
        console.error('dsh-web-notification: binding failed for', sessionId, e)
        return
      }
      if (!session || typeof session.subscribe !== 'function') return
      let baseline = null
      try {
        const snap = session.getSnapshot()
        if (snap && snap.openState === 'open') baseline = maxTurnOf(snap)
      } catch (e) { /* ignore */ }
      let dispose
      try {
        dispose = session.subscribe(() => {
          const snap = session.getSnapshot()
          if (!snap || snap.openState !== 'open') return
          const current = maxTurnOf(snap)
          if (baseline === null) {
            baseline = current
            return
          }
          if (current > baseline) {
            baseline = current
            const userText = latestUserTextOf(snap, current)
            const label = userText !== '' ? userText : titleOf(sessionId)
            showNotification(sessionId, current, label)
          }
        })
      } catch (e) {
        console.error('dsh-web-notification: subscribe failed for', sessionId, e)
        return
      }
      watchers.set(sessionId, { dispose, baseline })
    }

    function unwatchSession(sessionId) {
      const w = watchers.get(sessionId)
      if (!w) return
      try { w.dispose() } catch (e) { /* ignore */ }
      watchers.delete(sessionId)
    }

    // 与会话列表保持同步：新增会话 → 建立监听；移除会话 → 取消监听。
    function syncWatchers() {
      let ids = []
      try {
        const snap = sessions && sessions.list && sessions.list.getSnapshot()
        ids = (snap && Array.isArray(snap.ids)) ? snap.ids : []
      } catch (e) {
        return
      }
      const seen = new Set(ids)
      for (const id of ids) watchSession(id)
      for (const id of [...watchers.keys()]) if (!seen.has(id)) unwatchSession(id)
    }

    ctx.effect(() => {
      if (!sessions || !sessions.list) return
      syncWatchers()
      let off
      try {
        off = sessions.list.subscribe(syncWatchers)
      } catch (e) {
        console.error('dsh-web-notification: list subscribe failed', e)
        return
      }
      return () => {
        try { off() } catch (e) { /* ignore */ }
        for (const id of [...watchers.keys()]) unwatchSession(id)
      }
    }, 'dsh-web-notification: session watchers')
  },
}
