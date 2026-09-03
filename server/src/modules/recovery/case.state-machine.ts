import type { CaseStatus } from './case.types.js';

/* ------------------------------------------------------------------ */
/*  Declared Transition Matrix (RCV-001)                              */
/* ------------------------------------------------------------------ */

export const TERMINAL_STATES: ReadonlySet<CaseStatus> = new Set([
  'recovered',
  'unrecovered',
  'suppressed',
  'expired',
  'failed'
]);

export const LEGAL_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  detected: ['diagnosing', 'suppressed', 'failed'],
  diagnosing: ['scoring', 'deciding', 'suppressed', 'failed'],
  scoring: ['deciding', 'suppressed', 'failed'],
  deciding: ['awaiting_approval', 'executing', 'suppressed', 'failed'],
  awaiting_approval: ['executing', 'suppressed', 'expired', 'failed'],
  executing: ['awaiting_outcome', 'recovered', 'unrecovered', 'failed'],
  awaiting_outcome: ['executing', 'deciding', 'recovered', 'unrecovered', 'expired', 'failed'],
  recovered: [],
  unrecovered: [],
  suppressed: [],
  expired: [],
  failed: []
};

export class InvalidCaseTransitionError extends Error {
  constructor(
    public readonly fromStatus: CaseStatus,
    public readonly toStatus: CaseStatus,
    message?: string
  ) {
    super(
      message ||
        `Invalid case transition from '${fromStatus}' to '${toStatus}'. Legal targets from '${fromStatus}': [${LEGAL_TRANSITIONS[fromStatus]?.join(', ') || 'none (terminal)'}].`
    );
    this.name = 'InvalidCaseTransitionError';
  }
}

/**
 * Validates whether a state transition is legal according to the declared transition table.
 * Returns true if allowed, false otherwise.
 */
export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  if (TERMINAL_STATES.has(from)) {
    return false;
  }
  const allowed = LEGAL_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Validates a state transition and throws an explicit error if illegal or terminal.
 */
export function validateTransition(from: CaseStatus, to: CaseStatus): void {
  if (TERMINAL_STATES.has(from)) {
    throw new InvalidCaseTransitionError(
      from,
      to,
      `Cannot transition from terminal state '${from}' to '${to}'. Terminal states accept no further transitions.`
    );
  }

  if (!canTransition(from, to)) {
    throw new InvalidCaseTransitionError(from, to);
  }
}

export function isTerminalStatus(status: CaseStatus): boolean {
  return TERMINAL_STATES.has(status);
}
