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

  async function refreshHistory(
    uiTreatment: HistoryFailureTreatment = 'error_overlay',
    workflowId?: string
  ): Promise<HistoryRefreshOutcome> {
    if (controller.signal.aborted) return 'aborted'
    const { signal } = controller
    const generation = ++latestStartedRefresh
    if (uiTreatment === 'error_overlay') latestSurfacedRefresh = generation
    const result = await listThreads({ signal, workflowId })
    if (signal.aborted || result.status === 'aborted') return 'aborted'
    if (result.status !== 'complete') {
      if (!ownsFailure(generation, uiTreatment)) return 'superseded'
      onFailure(result, uiTreatment)
      return result.status
    }
    const queryKey = workflowId ?? ''
    if (generation < (latestAppliedByQuery.get(queryKey) ?? 0))
      return 'superseded'
    if (
      workflowId !== undefined &&
      generation < (latestAppliedByQuery.get('') ?? 0)
    )
      return 'superseded'
    const sessions = result.threads.map(toChatSession)
    if (workflowId !== undefined) {
      filteredHistory.set(workflowId, { generation, sessions })
      const refreshedIds = new Set(sessions.map(({ id }) => id))
      history.replaceAll([
        ...sessions,
        ...history.sessions.filter(
          ({ id, workflowId: cachedWorkflowId }) =>
            cachedWorkflowId !== workflowId && !refreshedIds.has(id)
        )
      ])
    } else {
      const newerFilteredEntries = [...filteredHistory.entries()].filter(
        ([, entry]) => entry.generation > generation
      )
      const newerFilteredWorkflowIds = new Set(
        newerFilteredEntries.map(([filteredWorkflowId]) => filteredWorkflowId)
      )
      const newerFiltered = newerFilteredEntries.flatMap(
        ([, entry]) => entry.sessions
      )
      const refreshedIds = new Set(newerFiltered.map(({ id }) => id))
      history.replaceAll([
        ...newerFiltered,
        ...sessions.filter(
          ({ id, workflowId: sessionWorkflowId }) =>
            !refreshedIds.has(id) &&
            !(
              sessionWorkflowId &&
              newerFilteredWorkflowIds.has(sessionWorkflowId)
            )
        )
      ])
      for (const [filteredWorkflowId, entry] of filteredHistory) {
        if (entry.generation <= generation)
          filteredHistory.delete(filteredWorkflowId)
      }
    }
    latestAppliedByQuery.set(queryKey, generation)
    latestAppliedRefresh = Math.max(latestAppliedRefresh, generation)
    return 'complete'
  }

  return { refreshHistory }
}
