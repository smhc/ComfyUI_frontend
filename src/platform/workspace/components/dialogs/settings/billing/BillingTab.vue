<template>
  <div class="flex flex-col gap-12" data-testid="billing-tab">
    <WorkspaceHeaderMenu />
    <BillingPausedBanner
      :can-manage-billing="capabilities.canManageBilling.value"
    />
    <section class="flex flex-col gap-3" data-testid="billing-plan-section">
      <h2 class="m-0 text-base font-medium text-foreground">
        {{ $t('workspacePanel.billingTab.credits.plan') }}
      </h2>
      <div
        v-if="load === 'loading'"
        class="rounded-xl border border-card px-5 py-4"
        data-testid="billing-plan-skeleton"
        aria-busy="true"
      >
        <div class="flex flex-col gap-2">
          <Skeleton class="h-6 w-1/3" />
          <Skeleton class="h-4 w-2/3" />
        </div>
      </div>
      <div
        v-else-if="load === 'error'"
        class="flex items-center justify-between gap-4 rounded-xl border border-card px-5 py-4"
        role="alert"
        data-testid="billing-load-error"
      >
        <p class="m-0 text-sm text-muted-foreground">
          {{ $t('workspacePanel.billingTab.loadError') }}
        </p>
        <Button variant="secondary" size="md" class="shrink-0" @click="retry">
          {{ $t('workspacePanel.billingTab.tryAgain') }}
        </Button>
      </div>
      <BillingPlanRow
        v-else
        :state="planRow"
        :action="action"
        :can-manage-subscription="capabilities.canManageSubscription.value"
      />
    </section>

    <section
      v-if="load === 'ready'"
      class="flex flex-col gap-3"
      data-testid="billing-credits-section"
    >
      <BillingCreditsCard
        :state="creditsCard"
        :can-top-up="capabilities.canTopUp.value"
        @retry="retryBalance"
        @add-credits="addCredits"
      />
      <template v-if="flags.autoTopUpEnabled">
        <template v-if="capabilities.canManageAutoTopUp.value">
          <BillingAutoTopUpCard v-if="capabilities.canTopUp.value" />
        </template>
      </template>
    </section>

    <section class="flex flex-col gap-3" data-testid="billing-handoff">
      <h2 class="m-0 text-base font-medium text-foreground">
        {{ $t(`workspacePanel.billingTab.handoff.${handoffAudience}.label`) }}
      </h2>
      <div
        class="flex items-center justify-end rounded-xl border border-card px-5 py-4"
        data-testid="billing-handoff-card"
      >
        <Button
          as="a"
          :href="handoffUrl"
          target="_blank"
          rel="noopener"
          variant="secondary"
          size="md"
          class="shrink-0"
        >
          {{
            $t(`workspacePanel.billingTab.handoff.${handoffAudience}.action`)
          }}
          <i :class="cn(handoffIcon, 'size-4')" aria-hidden="true" />
        </Button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { cn } from '@comfyorg/tailwind-utils'
import { computed, onMounted } from 'vue'

import Button from '@/components/ui/button/Button.vue'
import Skeleton from '@/components/ui/skeleton/Skeleton.vue'
import { useBillingContext } from '@/composables/billing/useBillingContext'
import { useBillingDialogs } from '@/composables/billing/useBillingDialogs'
import { useFeatureFlags } from '@/composables/useFeatureFlags'
import { useTelemetry } from '@/platform/telemetry'
import { paymentIntentSourceForAddCreditsClick } from '@/platform/telemetry/utils/paymentIntentSource'
import WorkspaceHeaderMenu from '@/platform/workspace/components/dialogs/settings/WorkspaceHeaderMenu.vue'
import BillingPausedBanner from '@/platform/workspace/components/dialogs/settings/billing/BillingPausedBanner.vue'
import BillingAutoTopUpCard from '@/platform/workspace/components/dialogs/settings/billing/BillingAutoTopUpCard.vue'
import BillingCreditsCard from '@/platform/workspace/components/dialogs/settings/billing/BillingCreditsCard.vue'
import BillingPlanRow from '@/platform/workspace/components/dialogs/settings/billing/BillingPlanRow.vue'
import {
  deriveBillingTabLoad,
  planRowAction
} from '@/platform/workspace/components/dialogs/settings/billing/planRow'
import { useBillingCreditsCard } from '@/platform/workspace/components/dialogs/settings/billing/useBillingCreditsCard'
import { useBillingPlanRow } from '@/platform/workspace/components/dialogs/settings/billing/useBillingPlanRow'
import { useBillingCapabilities } from '@/platform/workspace/composables/useBillingCapabilities'
import { platformLink } from '@/platform/workspace/utils/platformLink'

const billing = useBillingContext()
const capabilities = useBillingCapabilities()
const { flags } = useFeatureFlags()
const { state: planRow } = useBillingPlanRow()
const { state: creditsCard } = useBillingCreditsCard(planRow)
const { showTopUpCreditsDialog } = useBillingDialogs()
const telemetry = useTelemetry()

const HANDOFF_PATH = {
  owner: '/profile/billing',
  member: '/profile/usage'
} as const

const handoffAudience = computed(() =>
  capabilities.canManageBilling.value ? 'owner' : 'member'
)

const load = computed(() =>
  deriveBillingTabLoad({
    billingError: billing.error.value,
    billingInitialized: billing.isInitialized.value,
    capabilitiesReady: capabilities.isReady.value,
    capabilitiesResolved: capabilities.hasResolvedCapabilities.value
  })
)

const action = computed(() =>
  planRowAction(planRow.value, {
    canSubscribeSelfServe: capabilities.canSubscribeSelfServe.value
  })
)

const handoffUrl = computed(() =>
  platformLink(HANDOFF_PATH[handoffAudience.value])
)

const handoffIcon = computed(() =>
  handoffAudience.value === 'owner'
    ? 'icon-[lucide--arrow-up-right]'
    : 'icon-[lucide--external-link]'
)

async function retryBalance() {
  await billing.fetchBalance().catch(() => undefined)
}

function addCredits() {
  telemetry?.trackAddApiCreditButtonClicked({ source: 'credits_panel' })
  void showTopUpCreditsDialog({
    source: paymentIntentSourceForAddCreditsClick('credits_panel')
  })
}

async function retry() {
  await Promise.allSettled([billing.initialize(), capabilities.refresh()])
}

onMounted(() => {
  if (!billing.isInitialized.value && !billing.isLoading.value) {
    void billing.initialize().catch(() => undefined)
  }
  void capabilities.initialize()
})
</script>
