/* ------------------------------------------------------------------ */
/*  Recovery Case & Lifecycle Types (RCV-001 / TASK-203)             */
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
