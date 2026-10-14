import { describe, expect, it, vi } from 'vitest'
import type { PickerMenuUpdate } from '../src/client/menu-update.ts'
import type { SessionReferenceMentionCandidate } from '@deepseek-ai/dsh-session-reference/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { REFERENCE_ANYTHING_NS } from '../src/client/locale.ts'
import { zh } from '../src/client/locale.ts'
import { createSessionSource } from '../src/client/source.ts'
import { describeSession, sessionFolderName, sortSessionCandidates } from '../src/client/session-presentation.ts'

const t: TranslateNS<typeof REFERENCE_ANYTHING_NS> = (key, params) => (zh[key as keyof typeof zh] ?? key).replace(/\{(\w+)\}/gu, (_, name: string) => String((params as Record<string, unknown> | undefined)?.[name] ?? ''))
const session = { sessionId: 'target' as never }
const request = { query: 'VV', quoted: false, position: 'inline' as const, drilled: false, signal: new AbortController().signal }
const row = (id: string, extra: Partial<SessionReferenceMentionCandidate> = {}): SessionReferenceMentionCandidate => ({
  sessionId: id as never, label: '共同父标题', displayTitle: `任务${id}`,
  mention: `@[任务${id}](dsh-session:${id})`, cwd: '/Users/example/exam', createdAt: 1,
  sameWorkspace: false, ...extra,
})

describe('会话列表展示', () => {
  it('标题和引用标签都采用子任务显示名，保留原始引用地址和不同 ID', async () => {
    const rows = [row('a'), row('b')]
    const source = createSessionSource(async () => rows, t)
    const candidates = await source.candidates(session, request)
    expect(candidates.map(candidate => candidate.name)).toEqual(['任务a', '任务b'])
    for (const [index, candidate] of candidates.entries()) {
      const outcome = source.onPick({ candidate, session, position: 'inline', via: 'menu', action: 'pick', span: { start: 0, end: 4, draftRev: 1 } })
      expect(outcome).toMatchObject({ insert: { label: rows[index]!.displayTitle, ref: rows[index]!.mention } })
    }
  })

  it('旧接口没有显示名时仍使用原标题，不会按标题去重', async () => {
    const source = createSessionSource(async () => [row('a', { displayTitle: undefined }), row('b', { displayTitle: undefined })], t)
    expect((await source.candidates(session, request)).map(candidate => candidate.name)).toEqual(['共同父标题', '共同父标题'])
  })

  it('右侧只显示工作目录末级名称，不展示完整 POSIX 或 Windows 地址', () => {
    for (const path of ['/Users/example/exam/', 'C:\\Users\\example\\exam\\', '\\\\server\\share\\exam\\']) {
      expect(sessionFolderName(path, t)).toBe('exam')
      const description = describeSession(row('a', { cwd: path }), { updatedAt: 2, origin: 'subagent' }, t)
      expect(description).toContain('exam · 更新于 ')
      expect(description).toContain(' · 子智能体')
      expect(description).not.toContain('Users')
      expect(description).not.toContain('server')
    }
    expect(sessionFolderName(undefined, t)).toBe('无文件夹')
    expect(sessionFolderName('/', t)).toBe('根目录')
    expect(sessionFolderName('C:\\', t)).toBe('根目录')
  })

  it('区分主会话、普通分叉和子智能体，子智能体优先于父关联', () => {
    expect(describeSession(row('a'), { updatedAt: 2 }, t)).toMatch(/主会话$/u)
    expect(describeSession(row('a'), { updatedAt: 2, parentId: 'parent' as never }, t)).toMatch(/分叉会话$/u)
    expect(describeSession(row('a'), { updatedAt: 2, origin: 'subagent', parentId: 'missing-parent' as never }, t)).toMatch(/子智能体$/u)
    expect(describeSession(row('a'), undefined, t)).toBe('exam · 更新时间未知 · 类型未知')
  })

  it('读取 DSH 活动更新时间，不把候选的创建时间冒充最近更新时间', () => {
    const candidate = row('a', { createdAt: Date.UTC(2026, 0, 1) })
    const updatedAt = Date.UTC(2026, 9, 14, 3, 30)
    const date = new Date(updatedAt).toLocaleString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    expect(describeSession(candidate, { updatedAt }, t)).toBe(`exam · 更新于 ${date} · 主会话`)
    for (const time of [0, NaN, Infinity, -1, candidate.createdAt - 1]) {
      expect(describeSession(candidate, { updatedAt: time }, t)).toContain('更新时间未知')
    }
  })

  it('异步查询完成后只读一次最新元数据快照', async () => {
    let updatedAt = 2
    const read = vi.fn(() => ({ a: { updatedAt } }))
    const search = vi.fn(async () => { updatedAt = 10; return [row('a')] })
    const source = createSessionSource(search, t, undefined, read)
    const candidates = await source.candidates(session, request)
    expect(read).toHaveBeenCalledOnce()
    expect(candidates[0]!.description).toBe(describeSession(row('a'), { updatedAt: 10 }, t))
  })

  it('在数量截断和折叠之前排序，未知更新时间排末尾', async () => {
    const rows = [row('a'), row('b'), row('c')]
    const summaries = { a: { updatedAt: 20 }, b: { updatedAt: 30 } }
    expect(sortSessionCandidates(rows, summaries, 'updated').map(item => item.sessionId)).toEqual(['b', 'a', 'c'])
    const source = createSessionSource(async () => rows, t, { order: 1, sort: 'updated', limit: 1, maxCandidates: 2, displayMode: 'collapse' }, () => summaries)
    expect((await source.candidates(session, request)).map(candidate => candidate.name)).toEqual(['任务b', '再显示 1 项'])
    expect(sortSessionCandidates([...rows].reverse(), summaries, 'name').map(item => item.sessionId)).toEqual(['a', 'b', 'c'])
  })

  it('已开菜单更新时间和类型变化只重投影，不再次搜索', async () => {
    let updatedAt = 2
    const search = vi.fn(async () => [row('a')])
    const updateMenu = vi.fn((_update: PickerMenuUpdate) => true)
    const source = createSessionSource(search, t,
      { order: 1, limit: 6, maxCandidates: 50, displayMode: 'collapse', updateMenu }, () => ({ a: { updatedAt, origin: 'subagent' } }))
    await source.candidates(session, request)
    source.refreshPresentation!()
    expect(updateMenu).not.toHaveBeenCalled()
    updatedAt = 20_000
    source.refreshPresentation!()
    expect(search).toHaveBeenCalledOnce()
    expect(updateMenu).toHaveBeenCalledOnce()
    expect(updateMenu.mock.calls[0]![0]).toMatchObject({
      reopen: false, candidates: [{ name: '任务a', description: describeSession(row('a'), { updatedAt, origin: 'subagent' }, t) }],
    })
  })

  it('取消查询后不读取元数据或产生候选', async () => {
    const controller = new AbortController()
    const read = vi.fn(() => ({}))
    const source = createSessionSource(async () => { controller.abort(); return [row('a')] }, t, undefined, read)
    expect(await source.candidates(session, { ...request, signal: controller.signal })).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })
})
