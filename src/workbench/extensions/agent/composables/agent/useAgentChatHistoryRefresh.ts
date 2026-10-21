import { onScopeDispose } from 'vue'

import type { AgentThreadSummary } from '@/workbench/extensions/agent/schemas/agentApiSchema'
import type {
  AgentRestClient,
  ThreadListing
} from '@/workbench/extensions/agent/services/agent/agentRestClient'
import type {
  ChatSession,
  useAgentChatHistoryStore
} from '@/workbench/extensions/agent/stores/agent/agentChatHistoryStore'

type HistoryRefreshFailure = Extract<
  ThreadListing,
  { status: 'incomplete' | 'failed' }
>

type HistoryFailureTreatment = 'error_overlay' | 'none'
type HistoryRefreshOutcome = ThreadListing['status'] | 'superseded'

type HistoryRefreshDeps = {
  listThreads: AgentRestClient['listThreads']
  history: Pick<
    ReturnType<typeof useAgentChatHistoryStore>,
    'replaceAll' | 'sessions'
  >
  untitledChat: () => string
  onFailure: (
    failure: HistoryRefreshFailure,
    uiTreatment: HistoryFailureTreatment
  ) => void
}

export function useAgentChatHistoryRefresh({
  listThreads,
  history,
  untitledChat,
  onFailure
}: HistoryRefreshDeps) {
  let latestStartedRefresh = 0
  let latestAppliedRefresh = 0
  const latestAppliedByQuery = new Map<string, number>()
  const latestAppliedByThread = new Map<string, number>()
  let latestSurfacedRefresh = 0
  const filteredHistory = new Map<
    string,
    { generation: number; sessions: ChatSession[] }
  >()
  const controller = new AbortController()

  onScopeDispose(() => controller.abort())

  function toChatSession(thread: AgentThreadSummary): ChatSession {
    const lastActivityAt = [
      thread.last_message_at,
      thread.updated_at,
      thread.created_at
    ]
      .map((stamp) => Date.parse(stamp))
      .find((time) => !Number.isNaN(time))
    return {
      id: thread.id,
      title: thread.title || thread.preview || untitledChat(),
      updatedAt: lastActivityAt ?? Date.now(),
      lastActivityAt,
      titleSource: thread.title ? 'server' : 'fallback',
      workflowId: thread.workflow_id || undefined
    }
  }

  function ownsFailure(
    generation: number,
    uiTreatment: HistoryFailureTreatment
  ): boolean {
    const failureOwner =
      uiTreatment === 'error_overlay'
        ? latestSurfacedRefresh
        : latestStartedRefresh
    return generation === failureOwner && generation > latestAppliedRefresh
  }

  function isSuperseded(generation: number, workflowId?: string): boolean {
    const queryKey = workflowId ?? ''
    if (generation < (latestAppliedByQuery.get(queryKey) ?? 0)) return true
    return (
      workflowId !== undefined &&
      generation < (latestAppliedByQuery.get('') ?? 0)
    )
  }

  function applyFilteredHistory(
    workflowId: string,
    generation: number,
    sessions: ChatSession[]
  ): void {
    const sessionsToApply = sessions.filter(
      ({ id }) => generation >= (latestAppliedByThread.get(id) ?? 0)
    )
    const protectedIds = new Set(
      history.sessions
        .filter(({ id }) => (latestAppliedByThread.get(id) ?? 0) > generation)
        .map(({ id }) => id)
    )
    filteredHistory.set(workflowId, {
      generation,
      sessions: sessionsToApply
    })
    for (const { id } of sessionsToApply) {
      latestAppliedByThread.set(id, generation)
    }
    const refreshedIds = new Set(sessionsToApply.map(({ id }) => id))
    history.replaceAll([
      ...sessionsToApply,
      ...history.sessions.filter(
        ({ id, workflowId: cachedWorkflowId }) =>
          !refreshedIds.has(id) &&
          (cachedWorkflowId !== workflowId || protectedIds.has(id))
      )
    ])
  }

  function applyFullHistory(generation: number, sessions: ChatSession[]): void {
    const newerFilteredEntries = [...filteredHistory.entries()].filter(
      ([, entry]) => entry.generation > generation
    )
    const newerFilteredWorkflowIds = new Set(
      newerFilteredEntries.map(([workflowId]) => workflowId)
    )
    const newestFilteredById = new Map<
      string,
      { generation: number; session: ChatSession }
    >()
    for (const [, entry] of newerFilteredEntries) {
      for (const session of entry.sessions) {
        const previous = newestFilteredById.get(session.id)
        if (!previous || entry.generation > previous.generation) {
          newestFilteredById.set(session.id, {
            generation: entry.generation,
            session
          })
        }
      }
    }
    const newerFiltered = [...newestFilteredById.values()].map(
      ({ session }) => session
    )
    const refreshedIds = new Set(newerFiltered.map(({ id }) => id))
    history.replaceAll([
      ...newerFiltered,
      ...sessions.filter(
        ({ id, workflowId }) =>
          !refreshedIds.has(id) &&
          !(workflowId && newerFilteredWorkflowIds.has(workflowId))
      )
    ])
    for (const [workflowId, entry] of filteredHistory) {
      if (entry.generation <= generation) filteredHistory.delete(workflowId)
    }
  }

  function applyRefreshResult(
    result: ThreadListing,
    generation: number,
    uiTreatment: HistoryFailureTreatment,
    workflowId?: string
  ): HistoryRefreshOutcome {
    if (controller.signal.aborted || result.status === 'aborted')
      return 'aborted'
    if (result.status !== 'complete') {
      if (!ownsFailure(generation, uiTreatment)) return 'superseded'
      onFailure(result, uiTreatment)
      return result.status
    }
    if (isSuperseded(generation, workflowId)) return 'superseded'
    const sessions = result.threads.map(toChatSession)
    if (workflowId === undefined) applyFullHistory(generation, sessions)
    else applyFilteredHistory(workflowId, generation, sessions)
    latestAppliedByQuery.set(workflowId ?? '', generation)
    latestAppliedRefresh = Math.max(latestAppliedRefresh, generation)
    return 'complete'
  }

  async function refreshHistory(
    uiTreatment: HistoryFailureTreatment = 'error_overlay',
    workflowId?: string
  ): Promise<HistoryRefreshOutcome> {
    if (controller.signal.aborted) return 'aborted'
    const { signal } = controller
    const generation = ++latestStartedRefresh
    if (uiTreatment === 'error_overlay') latestSurfacedRefresh = generation
    const result = await listThreads({ signal, workflowId })
    return applyRefreshResult(result, generation, uiTreatment, workflowId)
  }

  return { refreshHistory }
}
