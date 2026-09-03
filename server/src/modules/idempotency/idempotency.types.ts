export type IdempotencyStatus = 'processing' | 'completed' | 'failed';

export type IdempotencyRecord = {
  id: number;
  merchantId: number;
  idempotencyKey: string;
  requestPath: string;
  requestHash: string;
  responseStatus: number | null;
  responseBody: unknown | null;
  status: IdempotencyStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateIdempotencyRecordInput = {
  merchantId: number;
  idempotencyKey: string;
  requestPath: string;
  requestHash: string;
};
