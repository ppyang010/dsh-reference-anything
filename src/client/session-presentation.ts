import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionReferenceMentionCandidate } from '@deepseek-ai/dsh-session-reference/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { REFERENCE_ANYTHING_NS } from './locale.ts'

/** 仅借用会话列表元数据，不打开会话或扫描历史日志。 */
export interface SessionPresentationMetadata {
  cwd?: string
  parentId?: SessionId
  origin?: 'subagent'
  updatedAt: number
}

export type SessionPresentationIndex = Readonly<Partial<Record<SessionId, SessionPresentationMetadata>>>

type T = TranslateNS<typeof REFERENCE_ANYTHING_NS>

export function sessionFolderName(cwd: string | undefined, t: T): string {
  if (!cwd) return t('session.noFolder')
  const normalized = cwd.replaceAll('\\', '/').replace(/\/+$/u, '')
  if (normalized === '' || /^[A-Za-z]:$/u.test(normalized)) return t('session.rootFolder')
  return normalized.split('/').at(-1) || t('session.noFolder')
}

/** 与 DSH 列表相同的活动时间；缺失时显式未知，不能伪装成创建时间。 */
export function sessionUpdatedAt(row: SessionReferenceMentionCandidate, summary: SessionPresentationMetadata | undefined): number | undefined {
  const time = summary?.updatedAt
  return time !== undefined && Number.isFinite(time) && time > 0 && time >= row.createdAt ? time : undefined
}

export function describeSession(row: SessionReferenceMentionCandidate, summary: SessionPresentationMetadata | undefined, t: T): string {
  const updatedAt = sessionUpdatedAt(row, summary)
  const date = updatedAt === undefined ? undefined : new Date(updatedAt)
  const updated = date === undefined || Number.isNaN(date.getTime())
    ? t('session.unknownUpdated')
    : t('session.updated', { date: date.toLocaleString(undefined, {
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }) })
  const type = summary === undefined ? 'session.type.unknown'
    : summary.origin === 'subagent' ? 'session.type.subagent'
      : summary.parentId !== undefined ? 'session.type.fork' : 'session.type.main'
  return [sessionFolderName(summary?.cwd ?? row.cwd, t), updated, t(type)].join(' · ')
}

/** 排序发生在折叠和数量截断之前；不同会话 ID 不按标题合并。 */
export function sortSessionCandidates(
  rows: readonly SessionReferenceMentionCandidate[],
  summaries: SessionPresentationIndex,
  sort: 'name' | 'updated' | undefined,
): SessionReferenceMentionCandidate[] {
  if (sort === undefined) return [...rows]
  return [...rows].sort((a, b) => {
    if (sort === 'name') return (a.displayTitle ?? a.label).localeCompare(b.displayTitle ?? b.label)
    return (sessionUpdatedAt(b, summaries[b.sessionId]) ?? 0) - (sessionUpdatedAt(a, summaries[a.sessionId]) ?? 0)
      || b.createdAt - a.createdAt
      || a.sessionId.localeCompare(b.sessionId)
  })
}
