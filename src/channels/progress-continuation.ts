import type { ChannelProgressDraftCompositorSnapshot } from "./progress-draft-compositor.types.js";
import type { ItemProgressPayload } from "./progress-draft-events.js";
import type { AgentPlanStep } from "./streaming.js";

/** The 2026.9.8 receipt handoff argument; the host no longer offers that capability. */
export type ProgressContinuationReceipt = {
  channel: string;
  accountId?: string;
  to: string;
  threadId?: string | number;
  messageId: string;
  text: string;
  snapshot: ChannelProgressDraftCompositorSnapshot;
};

export type ProgressContinuationState = {
  operationId: string;
};

/** The adopting owner's current checklist, in the shape a live turn receives it. */
export type ProgressContinuationPlan = {
  steps: AgentPlanStep[];
  explanation?: string;
  explanationFormat?: "plain";
};

/**
 * A confirmed progress draft the channel keeps after its turn ends. The channel
 * owns rendering, throttling and deletion; the adopting owner only pushes
 * prepared items and the requester's own checklist, and retires the draft once.
 */
export type ProgressContinuationDraft = {
  push: (item: ItemProgressPayload) => void;
  /** Replaces the card's checklist; channels that render none omit it. */
  pushPlan?: (plan: ProgressContinuationPlan) => void;
  retire: () => void;
};

export type ProgressContinuationCapability = {
  adopt: (this: void, draft: ProgressContinuationDraft) => boolean;
  close: () => void;
};
