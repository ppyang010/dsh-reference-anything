// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { createPickerMenuActionGuard, createPickerMenuUpdater } from '../src/client/menu-update.ts'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InputTriggerController, InputTriggerServiceContract, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createDoubleAtBridge, detectDoubleAt } from '../src/client/double-at.ts'
import { createCloudDriveSource, createFileSource, createConversationSource, FILE_SOURCE, DRIVE_SOURCE, CONVERSATION_SOURCE } from '../src/client/source.ts'

// 官方客户端是 ModuleLoader 工厂；测试载入实际控制器，DOM 外观依赖使用空替身。
const require = createRequire(import.meta.url)
const modulePath = require.resolve('@deepseek-ai/dsh-client-ui-input-trigger/client')
let Controller!: new (options: unknown) => InputTriggerController
vm.runInNewContext(readFileSync(modulePath, 'utf8'), {
  window: { __ModuleLoader__: { load: ({ factory }: { factory: (require: (id: string) => unknown) => { InputTriggerController: typeof Controller } }) => {
    Controller = factory(id => id === '@deepseek-ai/cordis' ? { Service: class {} }
      : id === '@deepseek-ai/dsh-client-store' ? { createSnapshotStore }
        : id === '@deepseek-ai/dsh-client-ui-primitives' ? { composerPlaceholder: () => '' }
          : require(id)).InputTriggerController
  } } },
  AbortController, console, queueMicrotask, setTimeout, clearTimeout,
})

async function tick(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 0)) }

function bench(id = 'one') {
  const sources: InputTriggerSource[] = []
  const effects: Array<() => void> = []
  const events: Array<{ name: string; payload: any }> = []
  let draft = ''
  let revision = 0
  let controller!: InputTriggerController
  const actx = {
    effect: (run: () => (() => void)) => { effects.push(run()) },
    bail: (_subject: unknown, name: string, payload: any) => {
      events.push({ name, payload })
      if (payload.span.draftRev !== revision) return false
      if (name === 'slash/input-insert-reference') {
        draft = `${draft.slice(0, payload.span.start)}\uFFFC${draft.slice(payload.span.end)}`
        revision++
        controller.track(draft, payload.span.start + 1, { tier: 'plain' }, revision)
      } else if (name === 'slash/input-insert-text') {
        draft = `${draft.slice(0, payload.span.start)}${payload.text}${draft.slice(payload.span.end)}`
        revision++
        controller.track(draft, payload.span.start + payload.text.length, { tier: 'plain' }, revision)
      }
      return true
    },
  } as unknown as Context
  const roster = { sources: (trigger: string) => sources.filter(source => source.trigger === trigger), all: () => sources }
  controller = new Controller({ actx, sessionId: id, roster })
  const originalTrack = controller.track
  const inputTriggers = { sessionOf: () => controller, registerSource: (source: InputTriggerSource) => { sources.push(source); return () => {} } } as InputTriggerServiceContract
  const originalSessionOf = inputTriggers.sessionOf
  const sessions = { sessionOf: () => ({ sessionId: id }) } as unknown as Pick<ISessions, 'sessionOf'>
  const bridge = createDoubleAtBridge(inputTriggers, sessions, new Set([FILE_SOURCE, DRIVE_SOURCE, CONVERSATION_SOURCE]))
  inputTriggers.sessionOf(actx)
  const updateMenu = createPickerMenuUpdater(inputTriggers, { scope: () => actx } as unknown as ISessions, (_source, _anchor, run) => run(), sessionId => bridge.capture(sessionId))
  const guardMenuActions = createPickerMenuActionGuard(inputTriggers, { scope: () => actx } as unknown as ISessions)
  const options = { order: 0, limit: 6, maxCandidates: 50, displayMode: 'collapse' as const, doubleAt: bridge, updateMenu, guardMenuActions }
  function replaceController() {
    controller.dispose()
    for (const off of effects.splice(0)) off()
    controller = new Controller({ actx, sessionId: id, roster })
    inputTriggers.sessionOf(actx)
    return controller
  }
  return {
    get controller() { return controller }, bridge, options, sources, events, effects, inputTriggers, originalSessionOf, originalTrack, replaceController,
    get draft() { return draft },
    get revision() { return revision },
    async track(text: string, caret = text.length, tier: 'plain' | 'frozen' = 'plain') {
      draft = text; revision++
      controller.track(draft, caret, { tier }, revision)
      await tick()
    },
    close() { controller.dismiss() },
    dispose() { bridge.dispose(); controller.dispose(); for (const off of effects) off() },
  }
}

describe('双 @ 的真实输入控制器回归', () => {
  it('解析双 @，等长转置带空格和已闭合的路径', () => {
    for (const text of ['@@', '@@foo', '前文 @@file:foo', '\n@@中文😀', '@@"目录 with space', '@@"目录 with space"', '@@"docs @"']) {
      const token = detectDoubleAt(text, text.length)!
      expect(token).toBeDefined()
      expect(token.virtualDraft.length).toBe(text.length)
      expect(token.end).toBe(text.length)
      expect(text.slice(token.start, token.start + 2)).toBe('@@')
    }
    expect(detectDoubleAt('@@"目录 @@foo', 11)?.query).toBe('目录 @@foo')
    for (const text of ['@', '@foo', '@"@foo', '@"目录 @@foo', '@"@@foo', '@@@foo', 'email@@foo', 'word,@@foo']) {
      expect(detectDoubleAt(text, text.length)).toBeUndefined()
    }
  })

  it('单 @ 没有插件候选和加载组，双 @ 才搜索', async () => {
    const b = bench()
    const load = vi.fn(async () => [{ path: 'readme.md', kind: 'file' as const }])
    b.sources.push(createFileSource(load, undefined, b.options))
    try {
      for (const text of ['@', '@foo', '@"@foo', '@@@foo', 'email@@foo']) {
        await b.track(text)
        expect(b.controller.menu.getSnapshot().groups).toHaveLength(0)
      }
      expect(load).not.toHaveBeenCalled()
      await b.track('@@foo')
      expect(load).toHaveBeenCalledWith(expect.any(String), 'foo', expect.any(AbortSignal))
      expect(b.controller.menu.getSnapshot().groups[0]?.items[0]?.name).toBe('readme.md')
      await b.track('@foo')
      expect(b.controller.menu.getSnapshot().groups).toHaveLength(0)
      expect(load).toHaveBeenCalledTimes(1)
    } finally { b.dispose() }
  })

  it('同核心命中的单双 @ 引号切换不复用旧候选，且不破坏 Esc', async () => {
    const b = bench()
    const load = vi.fn(async () => [{ path: 'foo.md', kind: 'file' as const }])
    b.sources.push(createFileSource(load, undefined, b.options))
    try {
      await b.track('@@"foo')
      expect(load).toHaveBeenCalledTimes(1)
      await b.track('@"@foo')
      expect(load).toHaveBeenCalledTimes(1)
      expect(b.controller.menu.getSnapshot().groups).toHaveLength(0)
      await b.track('@@"foo')
      expect(load).toHaveBeenCalledTimes(2)
      b.controller.arbitrate('escape', false)
      await b.track('@@"foo')
      expect(b.controller.menu.getSnapshot().open).toBe(false)
      expect(load).toHaveBeenCalledTimes(2)
      await b.track('@@"foo', undefined, 'frozen')
      await b.track('@@"foo')
      expect(b.controller.menu.getSnapshot().open).toBe(false)
      await b.track('@@"foob')
      expect(load).toHaveBeenCalledTimes(3)
    } finally { b.dispose() }
  })

  it('引用插入沿用原生跨度和版本，两个 @ 不残留且前后文保留', async () => {
    const b = bench()
    b.sources.push(createFileSource(async () => [{ path: 'doc.md', kind: 'file' }], undefined, b.options))
    try {
      await b.track('前文 @@doc 后文', '前文 @@doc'.length)
      const revision = b.revision
      b.controller.pick(FILE_SOURCE, 0)
      expect(b.draft).toBe('前文 \uFFFC 后文')
      expect(b.events[0]?.payload.span).toEqual({ start: 3, end: 8, draftRev: revision })
      expect(b.events[0]?.payload.reference.ref).toBe('@doc.md')
      expect(b.events[0]?.payload.reference.clipboardText).toBe('@doc.md')
    } finally { b.dispose() }
  })

  it('完整带空格引号查询不漏给 API 载体字符，插入无引号残留', async () => {
    const b = bench()
    const load = vi.fn(async () => [{ path: '目录 with space/doc.md', kind: 'file' as const }])
    b.sources.push(createFileSource(load, undefined, b.options))
    try {
      await b.track('@@"目录 with space"')
      expect(load).toHaveBeenCalledWith(expect.any(String), '目录 with space', expect.any(AbortSignal))
      b.controller.pick(FILE_SOURCE, 0)
      expect(b.draft).toBe('\uFFFC')
      expect(b.events[0]?.payload.reference.ref).toBe('@"目录 with space/doc.md"')
    } finally { b.dispose() }
  })

  it('目录 Tab 继续保持双 @，带空格下一层再插入 canonical 引用', async () => {
    const b = bench()
    const load = vi.fn(async (_id, query: string) => query === ''
      ? [{ path: 'docs with space', kind: 'directory' as const }]
      : [{ path: 'docs with space/a.md', kind: 'file' as const }])
    b.sources.push(createFileSource(load, undefined, b.options))
    try {
      await b.track('@@')
      b.controller.pick(FILE_SOURCE, 0, 'drill')
      await tick()
      expect(b.draft).toBe('@@"docs with space/')
      expect(load).toHaveBeenLastCalledWith(expect.any(String), 'docs with space/', expect.any(AbortSignal))
      b.controller.pick(FILE_SOURCE, 0)
      expect(b.draft).toBe('\uFFFC')
      expect(b.events.at(-1)?.payload.reference.ref).toBe('@"docs with space/a.md"')
    } finally { b.dispose() }
  })

  it('云盘搜索导航和空格完成路径都保持既有提交语法', async () => {
    const b = bench()
    b.sources.push(createCloudDriveSource(async () => [], undefined, b.options))
    try {
      await b.track('@@')
      b.controller.pick(DRIVE_SOURCE, 0)
      await tick()
      expect(b.draft).toBe('@@drive:')
      await b.track('@@drive:/folder/')
      expect(b.controller.onSpace()).toBe(true)
      expect(b.draft).toBe('@"drive:/folder/" ')
    } finally { b.dispose() }
  })

  it('Esc 或删除入口后，缓存刷新和排队菜单写入不能复活旧菜单', async () => {
    const b = bench()
    const search = vi.fn(async () => [])
    const source = createConversationSource(search, undefined, b.options)
    b.sources.push(source)
    try {
      await b.track('@@')
      const captured = b.controller.menu.getSnapshot()
      const valid = b.bridge.capture('one' as never)
      b.close()
      expect(valid()).toBe(false)
      await source.refreshCachedMenu({ refetch: true })
      expect(search).toHaveBeenCalledTimes(1)
      b.controller.menu.set(captured)
      expect(b.controller.menu.getSnapshot().open).toBe(false)
      await b.track('plain text')
      b.controller.menu.set(captured)
      expect(b.controller.menu.getSnapshot().open).toBe(false)
    } finally { b.dispose() }
  })

  it('官方命令按钮仍可通过程序入口打开，不受旧双 @ 状态影响', async () => {
    const b = bench()
    b.sources.push({ trigger: '/', name: 'native-command', candidates: async () => [{ name: 'plan' }], onPick: () => undefined })
    b.sources.push(createFileSource(async () => [], undefined, b.options))
    try {
      for (const previous of ['', '@@file']) {
        await b.track(previous)
        b.controller.toggleSource('native-command', { trigger: '/', query: '', quoted: false, position: 'leading', span: { start: 0, end: 0, draftRev: b.revision } })
        await tick()
        expect(b.controller.menu.getSnapshot().open).toBe(true)
        expect(b.controller.menu.getSnapshot().groups[0]?.items[0]?.name).toBe('plan')
        b.close()
      }
    } finally { b.dispose() }
  })

  it('查询细化的 pending 高亮继续消费 Enter 和 Tab，避免误提交', async () => {
    const b = bench()
    let resolve!: (value: readonly { path: string; kind: 'file' }[]) => void
    b.sources.push(createFileSource(async (_id, query) => query === 'f' ? [{ path: 'file.md', kind: 'file' }]
      : new Promise(done => { resolve = done }), undefined, b.options))
    try {
      await b.track('@@f')
      b.controller.hover(FILE_SOURCE, 0)
      await b.track('@@fo')
      expect(b.controller.menu.getSnapshot().highlight).toEqual({ source: FILE_SOURCE, index: 0 })
      expect(b.controller.arbitrate('enter', false)).toBe('consumed')
      expect(b.controller.arbitrate('tab', false)).toBe('consumed')
      resolve([{ path: 'file.md', kind: 'file' }])
      await tick()
    } finally { b.dispose() }
  })

  it('冻结后同版本重开也不能让旧代菜单有效性检查通过', async () => {
    const b = bench()
    b.sources.push(createFileSource(async () => [{ path: 'file.md', kind: 'file' }], undefined, b.options))
    try {
      await b.track('@@file')
      const valid = b.bridge.capture('one' as never)
      const generation = b.controller.menu.getSnapshot().generation
      b.controller.track(b.draft, b.draft.length, { tier: 'frozen' }, b.revision)
      b.controller.track(b.draft, b.draft.length, { tier: 'plain' }, b.revision)
      await tick()
      expect(b.controller.menu.getSnapshot().generation).toBeGreaterThan(generation)
      expect(valid()).toBe(false)
    } finally { b.dispose() }
  })

  it('旧 unquoted 后台刷新不能覆盖同 raw query 的新 quoted 菜单', async () => {
    const b = bench()
    const pending: Array<(rows: readonly { path: string; kind: 'file' }[]) => void> = []
    let calls = 0
    const source = createFileSource(async () => ++calls === 1 ? [{ path: 'initial.md', kind: 'file' }]
      : new Promise(done => pending.push(done)), undefined, b.options)
    b.sources.push(source)
    try {
      await b.track('@@foo')
      const refresh = source.refreshCachedMenu({ refetch: true })
      await b.track('@@"foo')
      pending[0]!([{ path: 'stale.md', kind: 'file' }])
      await refresh
      expect(b.controller.menu.getSnapshot().groups[0]?.status).toBe('pending')
      expect(b.controller.menu.getSnapshot().groups[0]?.items.some(row => row.name === 'stale.md')).toBe(false)
      pending[1]!([{ path: 'quoted.md', kind: 'file' }])
      await tick()
      expect(b.controller.menu.getSnapshot().groups[0]?.items[0]?.name).toBe('quoted.md')
    } finally { b.dispose() }
  })

  it('连续重开 @@ 不会被已取消的 SWR 刷新占住', async () => {
    const b = bench()
    const pending: Array<(rows: readonly any[]) => void> = []
    let calls = 0
    const source = createCloudDriveSource(async () => ++calls === 1 ? [{ id: 'old', provider: 'drive', label: 'old' } as never]
      : new Promise(done => pending.push(done)), undefined, b.options)
    b.sources.push(source)
    try {
      await b.track('@@')
      await b.track('none')
      await b.track('@@')
      await b.track('none')
      await b.track('@@')
      expect(calls).toBe(3)
      pending[0]!([{ id: 'stale', provider: 'drive', label: 'stale' }])
      await tick()
      pending[1]!([{ id: 'fresh', provider: 'drive', label: 'fresh' }])
      await tick()
      expect(b.controller.menu.getSnapshot().groups[0]?.items[0]?.name).toBe('fresh')
    } finally { b.dispose() }
  })

  it('同 ID 重建作用域后，SWR 的缓存展开折叠仍保留菜单', async () => {
    const b = bench()
    let calls = 0
    const source = createCloudDriveSource(async () => ++calls === 1
      ? ['A', 'B', 'C'].map(label => ({ id: label, provider: 'drive', label } as never))
      : new Promise(() => {}), undefined, { ...b.options, limit: 1 })
    b.sources.push(source)
    const chooseAction = (action: 'expand' | 'collapse') => {
      const group = b.controller.menu.getSnapshot().groups.find(row => row.source === DRIVE_SOURCE)!
      const index = group.items.findIndex(row => row.value !== undefined && JSON.parse(row.value).action === action)
      expect(index).toBeGreaterThanOrEqual(0)
      b.controller.pick(DRIVE_SOURCE, index)
    }
    try {
      await b.track('@@')
      chooseAction('expand')
      expect(b.controller.menu.getSnapshot().open).toBe(true)
      b.replaceController()
      await b.track('@@')
      chooseAction('collapse')
      expect(b.controller.menu.getSnapshot().open).toBe(true)
      chooseAction('expand')
      expect(b.controller.menu.getSnapshot().open).toBe(true)
      expect(b.controller.menu.getSnapshot().groups[0]?.items.filter(row => ['A', 'B', 'C'].includes(row.name))).toHaveLength(3)
    } finally { b.dispose() }
  })

  it('真实 Cordis 追踪服务可以卸载恢复，不累积热加载包装', () => {
    const root = new Context()
    class Triggers extends Service {
      constructor(ctx: Context) { super(ctx, 'inputTriggers') }
      sessionOf(): InputTriggerController { throw new Error('本测试不建立作用域') }
      registerSource(): () => void { return () => {} }
    }
    const raw = new Triggers(root)
    const original = raw.sessionOf
    const proxy = root.get('inputTriggers') as InputTriggerServiceContract
    expect(proxy.sessionOf === proxy.sessionOf).toBe(false)
    const bridge = createDoubleAtBridge(proxy, { sessionOf: () => undefined }, new Set())
    expect(raw.sessionOf).not.toBe(original)
    bridge.dispose()
    expect(raw.sessionOf).toBe(original)
  })

  it('过期候选、IME 仲裁和卸载后的第三方包装不受破坏', async () => {
    const b = bench()
    let resolve!: (value: readonly { path: string; kind: 'file' }[]) => void
    b.sources.push(createFileSource(() => new Promise(done => { resolve = done }), undefined, b.options))
    try {
      await b.track('@@foo')
      expect(b.controller.arbitrate('enter', true)).toBe('pass')
      await b.track('@foo')
      resolve([{ path: 'foo.md', kind: 'file' }])
      await tick()
      expect(b.controller.menu.getSnapshot().groups).toHaveLength(0)
      const previous = b.controller.track
      const foreign = vi.fn((...args: Parameters<typeof previous>) => previous.call(b.controller, ...args))
      b.controller.track = foreign
      b.bridge.dispose()
      expect(b.inputTriggers.sessionOf).toBe(b.originalSessionOf)
      expect(b.controller.track).toBe(foreign)
      await b.track('@plain')
      expect(foreign).toHaveBeenCalled()
    } finally { b.dispose() }
  })
})
