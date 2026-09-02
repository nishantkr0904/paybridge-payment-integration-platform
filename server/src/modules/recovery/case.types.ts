/* ------------------------------------------------------------------ */
/*  Recovery Case & Lifecycle Types (RCV-001 / RCV-002 / TASK-204)  */
/* ------------------------------------------------------------------ */

export type CaseStatus =
  | 'detected'
  | 'diagnosing'
  | 'scoring'
  | 'deciding'
  | 'awaiting_approval'
  | 'executing'
  | 'awaiting_outcome'
  | 'recovered'
  | 'unrecovered'
  | 'suppressed'
  | 'expired'
  | 'failed';

export type ActorType = 'system' | 'agent' | 'operator' | 'merchant';

export interface RecoveryCase {
  id: number;
  merchantId: number;
  caseRef: string;
  orderId: number;
  transactionId: number | null;
  status: CaseStatus;
  recoverableAmount: number;
  currency: string;
  originatingSignal: string;
  failureCategory: string | null;
  correlationId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CaseEvent {
  id: number;
  caseId: number;
  merchantId: number;
  fromStatus: CaseStatus | null;
  toStatus: CaseStatus;
  actorType: ActorType;
  actorId: string | null;
  reason: string | null;
  payload: Record<string, unknown> | null;
  correlationId: string;
  createdAt: Date;
}

export interface CreateCaseInput {
  orderId: number;
  transactionId?: number | null;
  recoverableAmount: number;
  currency?: string;
  originatingSignal: string;
  failureCategory?: string | null;
  correlationId: string;
  initialStatus?: CaseStatus;
}

export interface CreateCaseEventInput {
  fromStatus: CaseStatus | null;
  toStatus: CaseStatus;
  actorType: ActorType;
  actorId?: string | null;
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  correlationId: string;
}

export interface TransitionCaseInput {
  toStatus: CaseStatus;
  actorType: ActorType;
  actorId?: string | null;
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  correlationId: string;
}

export interface PaymentFailedEvent {
  eventType: string;
  merchantId: number;
  orderId: number;
  transactionId: number;
  orderRef?: string;
  txnRef?: string;
  amount: number;
  currency?: string;
  failureCategory?: string;
  failureReason?: string;
  gatewayResponse?: Record<string, unknown>;
  correlationId: string;
  timestamp?: string;
}

/* ------------------------------------------------------------------ */
/*  Prioritisation & Revenue Ledger Types (RCV-002)                   */
/* ------------------------------------------------------------------ */

export interface PriorityBreakdown {
  valueScore: number;
  ageScore: number;
  tierScore: number;
  categoryScore: number;
  propensityScore: number;
}

export interface PriorityScore {
  score: number;
  formula: string;
  derivationBasis: string;
  breakdown: PriorityBreakdown;
  isAddressable: boolean;
}

export interface PrioritizedCase {
  case: RecoveryCase;
  priority: PriorityScore;
}

export interface QueueMetrics {
  queueDepth: number;
  oldestCaseAgeSeconds: number;
  activeCasesByStatus: Record<string, number>;
  shedVolumeTotal: number;
}

export interface CategoryBreakdown {
  failureCategory: string;
  isAddressable: boolean;
  caseCount: number;
  detectedMinorUnits: number;
  recoveredMinorUnits: number;
  suppressedMinorUnits: number;
  unrecoveredMinorUnits: number;
  inFlightMinorUnits: number;
}

export interface RevenueLedger {
  merchantId: number;
  currency: string;
  period: {
    startDate?: Date;
    endDate?: Date;
  };
  totals: {
    totalDetectedMinorUnits: number;
    addressableMinorUnits: number;
    nonAddressableMinorUnits: number;
    recoveredMinorUnits: number;
    unrecoveredMinorUnits: number;
    suppressedMinorUnits: number;
    inFlightMinorUnits: number;
    totalCaseCount: number;
  };
  byCategory: CategoryBreakdown[];
}

export interface LedgerFilters {
  startDate?: Date;
  endDate?: Date;
  currency?: string;
}
