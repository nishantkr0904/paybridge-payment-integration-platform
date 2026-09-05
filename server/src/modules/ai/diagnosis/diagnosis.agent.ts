import { getLLMProvider } from '../../../infrastructure/llm/llm.provider.js';
import { formatBoundedFallbackReason, type LLMProvider } from '../../../infrastructure/llm/llm.types.js';
import { logger } from '../../../utils/logger.js';
import { generateUlid } from '../../../utils/ulid.js';
import { REPAIR_PROMPT_TEMPLATE } from '../prompts/diagnosis.prompt.js';
import { promptRegistry, renderPrompt } from '../prompts/prompt.registry.js';
import {
  DiagnoseCaseInput,
  DiagnosisRawOutput,
  DiagnosisRawOutputSchema,
  DiagnosisResult
} from './diagnosis.types.js';
import { deriveRulesDiagnosis } from './rules.fallback.js';

/* ------------------------------------------------------------------ */
/*  Payment Failure Diagnosis Agent (AI-002 / AI-003 / AI-004)        */
/* ------------------------------------------------------------------ */

/**
 * Executes structured AI diagnosis for a recovery case over pre-assembled,
 * strictly PII-redacted context. Enforces prompt versioning, structured output
 * schema validation with bounded repair, and deterministic rules fallback.
 *
 * Guaranteed to never fail unhandled or leave a case undiagnosed.
 */
export async function diagnosePaymentFailure(
  input: DiagnoseCaseInput,
  customProvider?: LLMProvider
): Promise<DiagnosisResult> {
  const correlationId = input.correlationId || input.context.observability.correlationId || generateUlid();
  const provider = customProvider || getLLMProvider();

  // 1. Force fallback check (AI-004)
  if (input.forceFallback) {
    logger.info({ correlationId }, '[DiagnosisAgent] Fallback forced by caller');
    return deriveRulesDiagnosis(input.context, correlationId, 'FORCED_FALLBACK');
  }

  // 2. Load and render versioned prompt template (AI-010)
  let template;
  try {
    template = promptRegistry.getTemplate('payment_failure_diagnosis', input.promptVersion);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown template error';
    logger.warn({ correlationId, err }, `[DiagnosisAgent] Template error: ${errorMsg}. Engaging fallback.`);
    return deriveRulesDiagnosis(input.context, correlationId, 'PROMPT_TEMPLATE_ERROR');
  }

  const rendered = renderPrompt(template, {
    contextJson: JSON.stringify(input.context, null, 2)
  });

  const startTime = Date.now();
  let repairAttempted = false;

  try {
    // 3. Primary LLM Provider invocation (AI-001 / AI-002)
    const response = await provider.complete({
      task: 'diagnosis',
      prompt: rendered.userPrompt,
      systemPrompt: rendered.systemPrompt,
      correlationId,
      promptVersion: template.version,
      timeoutMs: 20000
    });

    let rawData: unknown = response.structuredData;
    if (!rawData) {
      try {
        rawData = JSON.parse(response.content);
      } catch {
        rawData = null;
      }
    }

    let validationResult = DiagnosisRawOutputSchema.safeParse(rawData);

    // 4. Bounded repair attempt on schema validation failure (AI-003)
    if (!validationResult.success) {
      repairAttempted = true;
      const formattedErrors = JSON.stringify(validationResult.error.format(), null, 2);
      logger.warn(
        { correlationId, errors: formattedErrors },
        '[DiagnosisAgent] Initial completion failed schema validation. Attempting single repair.'
      );

      const repairPrompt = REPAIR_PROMPT_TEMPLATE
        .replace('{{validationErrors}}', formattedErrors)
        .replace('{{contextJson}}', JSON.stringify(input.context, null, 2));

      try {
        const repairResponse = await provider.complete({
          task: 'diagnosis',
          prompt: repairPrompt,
          systemPrompt: rendered.systemPrompt,
          correlationId,
          promptVersion: template.version,
          timeoutMs: 20000
        });

        let repairedData: unknown = repairResponse.structuredData;
        if (!repairedData) {
          try {
            repairedData = JSON.parse(repairResponse.content);
          } catch {
            repairedData = null;
          }
        }

        validationResult = DiagnosisRawOutputSchema.safeParse(repairedData);
      } catch (repairErr) {
        logger.warn(
          { correlationId, err: repairErr },
          '[DiagnosisAgent] Repair attempt failed. Engaging deterministic fallback.'
        );
        return deriveRulesDiagnosis(input.context, correlationId, 'REPAIR_ATTEMPT_FAILED');
      }
    }

    // 5. If validation still failed after repair, fallback to rules engine
    if (!validationResult.success) {
      logger.warn(
        { correlationId, errors: validationResult.error.errors },
        '[DiagnosisAgent] Completion failed validation after repair. Engaging deterministic fallback.'
      );
      return deriveRulesDiagnosis(input.context, correlationId, 'SCHEMA_VALIDATION_FAILED');
    }

    const diagnosis: DiagnosisRawOutput = validationResult.data;
    const latencyMs = Date.now() - startTime;

    // 6. Build final structured result with complete provenance (AI-002 / AI-008)
    return {
      category: diagnosis.category,
      reasonCode: diagnosis.reasonCode,
      rootCause: diagnosis.rootCause,
      contributingFactors: diagnosis.contributingFactors,
      recoverable: diagnosis.recoverable,
      recommendedStrategy: diagnosis.recommendedStrategy,
      confidence: Number(diagnosis.confidence.toFixed(2)),
      explanation: diagnosis.explanation,
      evidence: diagnosis.evidence,
      provenance: {
        source: 'model',
        promptId: template.id,
        promptVersion: template.version,
        modelId: response.modelId,
        tokens: {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens
        },
        latencyMs,
        contextVersion: input.context.schemaVersion,
        rulesVersion: null,
        repairAttempted,
        fallbackReason: null
      }
    };
  } catch (err) {
    // 7. Graceful fallback on provider failure, timeout, or circuit break (AI-004)
    const errorMsg = err instanceof Error ? err.message : 'Unknown provider error';
    logger.warn(
      { correlationId, err },
      `[DiagnosisAgent] LLM provider error (${errorMsg}). Engaging deterministic rules fallback.`
    );
    const fallbackReason = formatBoundedFallbackReason(err);
    return deriveRulesDiagnosis(input.context, correlationId, fallbackReason);
  }
}
