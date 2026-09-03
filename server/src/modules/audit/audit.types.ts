import type { CaseEvent, RecoveryCase } from '../recovery/case.types.js';
import type { AgentTrace } from '../ai/tracing/trace.types.js';

export type AuditExportFormat = 'json' | 'csv';

export type AuditExportMetadata = {
  exportId: string;
  generatedAt: string;
  generatedBy: string;
  merchantId: number;
  caseId: number;
  caseRef: string;
  integritySignature: string;
  eventCount: number;
  traceCount: number;
};

export type CaseAuditExportData = {
  metadata: AuditExportMetadata;
  case: RecoveryCase;
  events: CaseEvent[];
  traces: AgentTrace[];
};

export type ExportAuditOptions = {
  format?: AuditExportFormat;
  includeTraces?: boolean;
};
