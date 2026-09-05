import { generateUlid } from '../../utils/ulid.js';
import {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMTimeoutError
} from './llm.types.js';

export interface MockProviderOptions {
  mockLatencyMs?: number;
  failureInjector?: (request: LLMRequest, attempt: number) => Error | null;
}

export class MockLLMProvider implements LLMProvider {
  private customHandlers = new Map<string, (req: LLMRequest) => Partial<LLMResponse>>();
  private invocationHistory: LLMRequest[] = [];
  private mockLatencyMs: number;
  private failureInjector: ((request: LLMRequest, attempt: number) => Error | null) | null = null;
  private attemptCountByReq = new Map<string, number>();

  constructor(options?: MockProviderOptions) {
    this.mockLatencyMs = options?.mockLatencyMs ?? 5;
    this.failureInjector = options?.failureInjector ?? null;
  }

  public setMockLatency(latencyMs: number): void {
    this.mockLatencyMs = latencyMs;
  }

  public setFailureInjector(fn: ((request: LLMRequest, attempt: number) => Error | null) | null): void {
    this.failureInjector = fn;
  }

  public setTaskHandler(task: string, handler: (req: LLMRequest) => Partial<LLMResponse>): void {
    this.customHandlers.set(task, handler);
  }

  public getInvocations(): LLMRequest[] {
    return [...this.invocationHistory];
  }

  public clearHistory(): void {
    this.invocationHistory = [];
    this.customHandlers.clear();
    this.failureInjector = null;
    this.attemptCountByReq.clear();
  }

  public async complete(request: LLMRequest): Promise<LLMResponse> {
    const correlationId = request.correlationId || generateUlid();
    const attempts = (this.attemptCountByReq.get(correlationId) || 0) + 1;
    this.attemptCountByReq.set(correlationId, attempts);

    this.invocationHistory.push(request);

    // 1. Check failure injector
    if (this.failureInjector) {
      const injectedError = this.failureInjector(request, attempts);
      if (injectedError) {
        throw injectedError;
      }
    }

    // 2. Simulate latency
    if (this.mockLatencyMs > 0) {
      if (request.timeoutMs && this.mockLatencyMs > request.timeoutMs) {
        await new Promise((res) => setTimeout(res, request.timeoutMs));
        throw new LLMTimeoutError(request.timeoutMs);
      }
      await new Promise((res) => setTimeout(res, this.mockLatencyMs));
    }

    // 3. Custom handler if registered
    const customHandler = this.customHandlers.get(request.task);
    if (customHandler) {
      const partial = customHandler(request);
      return this.buildDefaultResponse(request, partial);
    }

    // 4. Default deterministic canned response per task
    return this.buildDefaultResponse(request);
  }

  private buildDefaultResponse(
    request: LLMRequest,
    override?: Partial<LLMResponse>
  ): LLMResponse {
    const inputTokenEstimate = Math.max(10, Math.floor(request.prompt.length / 4));
    const promptVersion = request.promptVersion || 'v1.0.0';
    const requestId = `req_mock_${generateUlid()}`;

    let defaultContent: string;
    let defaultStructuredData: Record<string, unknown> | null;
    let modelId: string;
    switch (request.task) {
      case 'diagnosis': {
        modelId = 'mock-diagnosis-v1';
        let category = 'INSUFFICIENT_FUNDS';
        let recoverable = true;
        let recommendedStrategy = 'DELAYED_RETRY';
        let rootCause = 'Temporary account balance deficit';

        // Extract context payload if embedded in prompt
        const match = request.prompt.match(/<<<BEGIN_UNTRUSTED_CONTEXT_PAYLOAD>>>\s*([\s\S]*?)\s*<<<END_UNTRUSTED_CONTEXT_PAYLOAD>>>/);
        if (match && match[1]) {
          try {
            const ctx = JSON.parse(match[1]);
            const cat = ctx.case?.failureCategory;
            if (cat) {
              category = cat;
              if (cat === 'FRAUD_BLOCK') {
                recoverable = false;
                recommendedStrategy = 'ABANDON';
                rootCause = 'High risk fraud velocity block';
              } else if (cat === 'CARD_EXPIRED' || cat === 'ISSUER_HARD_DECLINE') {
                recoverable = cat !== 'ISSUER_HARD_DECLINE';
                recommendedStrategy = 'ALTERNATE_PAYMENT_METHOD';
                rootCause = 'Card expired or closed';
              } else if (cat === 'AUTHENTICATION_FAILED') {
                recoverable = true;
                recommendedStrategy = 'CUSTOMER_OUTREACH';
                rootCause = '3DS OTP customer authentication timeout';
              } else if (cat === 'TECHNICAL_TRANSIENT' || cat === 'NETWORK_TIMEOUT') {
                recoverable = true;
                recommendedStrategy = 'IMMEDIATE_RETRY';
                rootCause = 'Transient network or gateway timeout';
              } else if (cat === 'CUSTOMER_ABANDONED') {
                recoverable = true;
                recommendedStrategy = 'CUSTOMER_OUTREACH';
                rootCause = 'Customer abandoned active checkout session';
              } else if (cat === 'ISSUER_DOWN' || cat === 'ISSUER_SOFT_DECLINE' || cat === 'VELOCITY_LIMIT') {
                recoverable = true;
                recommendedStrategy = 'DELAYED_RETRY';
                rootCause = 'Temporary issuer or velocity decline';
              }
            }
          } catch {
            // ignore parse error, use defaults
          }
        }

        defaultContent = JSON.stringify({
          category,
          reasonCode: category,
          rootCause,
          contributingFactors: ['Customer historic payment methods indicate active card usage'],
          recoverable,
          recommendedStrategy,
          confidence: category === 'INSUFFICIENT_FUNDS' ? 0.88 : 0.92,
          explanation: `Payment failure analyzed as ${category}. Recommended action: ${recommendedStrategy}.`,
          evidence: ['gatewayResponse.declineCode', 'customer.previousSuccess']
        });
        defaultStructuredData = JSON.parse(defaultContent);
        break;
      }

      case 'decision': {
        modelId = 'mock-decision-v1';
        const isAbandonment =
          request.prompt.includes('CUSTOMER_ABANDONED') ||
          request.prompt.includes('checkout.abandoned');

        const primaryActionType = isAbandonment ? 'CUSTOMER_OUTREACH' : 'RETRY_PAYMENT';
        const toolName = isAbandonment ? 'send_recovery_link' : 'schedule_payment_retry';
        const rationale = isAbandonment
          ? 'Send direct customer recovery outreach link after checkout abandonment'
          : 'Schedule automated retry 24 hours later during banking operational window';

        defaultContent = JSON.stringify({
          actionType: primaryActionType,
          scheduledDelaySeconds: isAbandonment ? 1800 : 86400,
          planRationale: rationale,
          actions: [
            {
              actionType: primaryActionType,
              toolName,
              scheduledDelaySeconds: isAbandonment ? 1800 : 86400,
              costMinorUnits: 0,
              incentivePercent: 0,
              rationale,
              parameters: isAbandonment ? { channel: 'email' } : {}
            }
          ],
          costOrderingRespect: true
        });
        defaultStructuredData = JSON.parse(defaultContent);
        break;
      }

      case 'summarisation':
        modelId = 'mock-summarisation-v1';
        defaultContent = 'Transaction failed due to issuer timeout. System-initiated recovery in progress.';
        defaultStructuredData = { summary: defaultContent };
        break;

      default:
        modelId = 'mock-llm-v1';
        defaultContent = 'Mock completion response.';
        defaultStructuredData = null;
        break;
    }

    const outputTokenEstimate = Math.max(10, Math.floor(defaultContent.length / 4));

    return {
      content: override?.content ?? defaultContent,
      structuredData: override?.structuredData !== undefined ? override.structuredData : defaultStructuredData,
      modelId: override?.modelId ?? modelId,
      promptVersion: override?.promptVersion ?? promptVersion,
      usage: override?.usage ?? {
        inputTokens: inputTokenEstimate,
        outputTokens: outputTokenEstimate,
        totalTokens: inputTokenEstimate + outputTokenEstimate,
        estimatedCostMinorUnits: 1
      },
      latencyMs: override?.latencyMs ?? this.mockLatencyMs,
      stopReason: override?.stopReason ?? 'stop',
      providerRequestId: override?.providerRequestId ?? requestId
    };
  }
}
