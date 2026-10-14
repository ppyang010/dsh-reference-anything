import { symbols, type Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  CandidateRequest, ClientSessionContext, InputTriggerController, InputTriggerServiceContract,
  MenuState, PickOutcome, TriggerGuard, TriggerPosition,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'

export interface DoubleAtToken {
  query: string
  rawQuery: string
  quoted: boolean
  position: TriggerPosition
  start: number
  end: number
  virtualDraft: string
}

/** 仅改变检测入参，保留真实编辑器文字、UTF-16 坐标和输入版本。 */
export function detectDoubleAt(draft: string, caret: number): DoubleAtToken | undefined {
  const prefix = draft.slice(0, caret)
  const quoted = /(?:^|\s)(@@"([^"\r\n]*)("?))$/u.exec(prefix)
  if (quoted?.[1] !== undefined) {
    const start = caret - quoted[1].length
    const query = quoted[2] ?? ''
    const closed = quoted[3] === '"'
    // 双 @ 开引号等长转置成 @"@；已闭合时只在检测串替换尾引号。
    const carrier = closed ? '\uE000' : ''
    const virtualToken = `@"@${query}${carrier}`
    return {
      query, rawQuery: `@${query}${carrier}`, quoted: true,
      position: draft.search(/\S/u) === start ? 'leading' : 'inline',
      start, end: caret,
      virtualDraft: `${draft.slice(0, start)}${virtualToken}${draft.slice(caret)}`,
    }
  }
  // 外层单 @ 引号拥有整个查询；先识别完整双 @ 引号，避免合法的尾部 @ 误判。
  if (/(?:^|\s)(@"[^"]*)$/u.test(prefix)) return undefined
  const plain = /(?:^|\s)(@@([^\s]*))$/u.exec(prefix)
  if (plain?.[1] === undefined || plain[2]?.startsWith('@') || plain[2]?.startsWith('"')) return undefined
  const start = caret - plain[1].length
  return {
    query: plain[2] ?? '', rawQuery: `@${plain[2] ?? ''}`, quoted: false,
    position: draft.search(/\S/u) === start ? 'leading' : 'inline',
    start, end: caret, virtualDraft: draft,
  }
}

export interface DoubleAtBridge {
  request(session: ClientSessionContext, request: CandidateRequest): CandidateRequest | undefined
  continuation(outcome: PickOutcome): PickOutcome
  space(session: ClientSessionContext, token: string): string | undefined
  isCurrent(session: ClientSessionContext, request: Pick<CandidateRequest, 'query' | 'quoted' | 'position'>): boolean
  capture(sessionId: SessionId): () => boolean
  dispose(): void
}

interface ControllerState {
  controller: InputTriggerController
  token: DoubleAtToken | undefined
  frozen: boolean
  revision: number
  epoch: number
  tracking: boolean
}

/** 官方仅支持单字符触发器；兼容层可撤销，不写官方源码或私有状态。 */
export function createDoubleAtBridge(
  inputTriggers: InputTriggerServiceContract,
  sessions: Pick<ISessions, 'sessionOf'>,
  ownedSources: ReadonlySet<string>,
): DoubleAtBridge {
  let enabled = true
  const states = new Map<SessionId, ControllerState>()
  const installed = new WeakSet<InputTriggerController>()
  const restorers = new Set<() => void>()
  // Cordis 的方法读取会生成追踪代理，函数身份恢复必须在原始 service 上比较。
  const rawService = (inputTriggers as unknown as { [symbols.original]?: InputTriggerServiceContract })[symbols.original] ?? inputTriggers
  const originalSessionOf = rawService.sessionOf

  const matches = (state: ControllerState | undefined, request: Pick<CandidateRequest, 'query' | 'quoted' | 'position'>): state is ControllerState => {
    const token = state?.token
    return enabled && state !== undefined && !state.frozen && token !== undefined
      && token.rawQuery === request.query && token.quoted === (request.quoted === true) && token.position === request.position
  }
  const stillOpen = (state: ControllerState): boolean => {
    const menu = state.controller.menu.getSnapshot()
    return menu.open && menu.hit !== null && matches(state, menu.hit)
      && menu.hit.span.start === state.token?.start && menu.hit.span.end === state.token?.end
  }

  function install(controller: InputTriggerController, actx: Context, id: SessionId): void {
    if (installed.has(controller)) return
    installed.add(controller)
    const state: ControllerState = { controller, token: undefined, frozen: false, revision: 0, epoch: 0, tracking: false }
    states.set(id, state)
    const originalTrack = controller.track
    const originalSet = controller.menu.set

    const wrappedSet: typeof originalSet = function (next) {
      if (!enabled || !next.open) return originalSet.call(controller.menu, next)
      const current = controller.menu.getSnapshot()
      // Esc、离开入口或切换输入后，排队的展开/后台刷新不得复活旧菜单。
      const launched = controller.launcher.getSnapshot()
      const nativeLauncher = launched !== null && !ownedSources.has(launched)
      if (!state.tracking && !current.open && !nativeLauncher) return
      const active = next.hit !== null && matches(state, next.hit)
        && next.hit.span.start === state.token?.start && next.hit.span.end === state.token?.end
      if (state.token !== undefined && !state.frozen && !active && !nativeLauncher) return
      const groups = next.groups.filter(group => active && !nativeLauncher ? ownedSources.has(group.source) : !ownedSources.has(group.source))
      // 查询细化的 pending 行仍应保留高亮，由原生仲裁消费 Enter/Tab。
      const highlight = next.highlight !== null && groups.some(group => group.source === next.highlight?.source
        && next.highlight!.index < group.items.length) ? next.highlight : null
      const projected: MenuState = groups.length === 0
        ? { ...next, open: false, hit: null, groups, highlight: null }
        : { ...next, groups, highlight }
      originalSet.call(controller.menu, projected)
    }

    const wrappedTrack: typeof originalTrack = function (draft, caret, guard, revision) {
      if (!enabled) return originalTrack.call(controller, draft, caret, guard, revision)
      state.revision = revision
      state.frozen = guard.tier === 'frozen'
      if (state.frozen) return originalTrack.call(controller, draft, caret, guard, revision)
      const next = detectDoubleAt(draft, caret)
      const previous = state.token
      const modeChanged = (previous === undefined) !== (next === undefined)
      const changed = previous?.rawQuery !== next?.rawQuery || previous?.query !== next?.query
        || previous?.quoted !== next?.quoted || previous?.start !== next?.start || previous?.end !== next?.end
      if (modeChanged || changed) state.epoch++
      state.token = next
      state.tracking = true
      try {
        if (modeChanged) {
          controller.dismiss()
          originalTrack.call(controller, '', 0, guard, revision)
        }
        originalTrack.call(controller, next?.virtualDraft ?? draft, caret, guard, revision)
      } finally {
        state.tracking = false
      }
    }
    controller.track = wrappedTrack
    controller.menu.set = wrappedSet
    let restored = false
    const restore = (): void => {
      if (restored) return
      restored = true
      if (controller.track === wrappedTrack) controller.track = originalTrack
      if (controller.menu.set === wrappedSet) controller.menu.set = originalSet
      if (states.get(id) === state) states.delete(id)
      restorers.delete(restore)
    }
    restorers.add(restore)
    actx.effect(() => restore, 'reference-anything.double-at.controller')
  }

  const wrappedSessionOf: typeof originalSessionOf = function (this: InputTriggerServiceContract, actx) {
    const controller = originalSessionOf.call(this, actx)
    if (enabled) {
      const session = sessions.sessionOf(actx)
      if (session !== undefined) install(controller, actx, session.sessionId)
    }
    return controller
  }
  rawService.sessionOf = wrappedSessionOf

  return {
    request(session, request) {
      const state = states.get(session.sessionId)
      if (request.signal.aborted || !matches(state, request)) return undefined
      return { ...request, query: state.token!.query, quoted: state.token!.quoted }
    },
    continuation(outcome) {
      return outcome !== undefined && outcome !== 'handled' && 'text' in outcome
        && outcome.continue === true && outcome.text.startsWith('@') && !outcome.text.startsWith('@@')
        ? { ...outcome, text: `@${outcome.text}` } : outcome
    },
    space(session, token) {
      const state = states.get(session.sessionId)
      return state?.token !== undefined && !state.frozen && enabled && token === `@${state.token.rawQuery}`
        ? `@${state.token.query}` : undefined
    },
    isCurrent(session, request) {
      const state = states.get(session.sessionId)
      return matches(state, request) && stillOpen(state)
    },
    capture(sessionId) {
      const state = states.get(sessionId)
      const epoch = state?.epoch
      const revision = state?.revision
      const generation = state?.controller.menu.getSnapshot().generation
      return () => state !== undefined && states.get(sessionId) === state
        && state.epoch === epoch && state.revision === revision
        && state.controller.menu.getSnapshot().generation === generation && stillOpen(state)
    },
    dispose() {
      enabled = false
      if (rawService.sessionOf === wrappedSessionOf) rawService.sessionOf = originalSessionOf
      for (const restore of [...restorers]) restore()
      states.clear()
    },
  }
}
