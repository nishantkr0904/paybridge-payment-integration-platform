import { getLLMProvider } from '../../../infrastructure/llm/llm.provider.js';
import type { LLMProvider } from '../../../infrastructure/llm/llm.types.js';
import { logger } from '../../../utils/logger.js';
import { generateUlid } from '../../../utils/ulid.js';
import { REPAIR_DECISION_PROMPT_TEMPLATE } from '../prompts/decision.prompt.js';
import { promptRegistry, renderPrompt } from '../prompts/prompt.registry.js';
import {
  DecisionPlan,
  DecisionRawOutput,
  DecisionRawOutputSchema,
  PlanDecisionInput
} from './decision.types.js';
import { deriveRulesDecisionPlan } from './rules.decision.js';

/* ------------------------------------------------------------------ */
/*  Recovery Decision Agent (AI-005 / AI-006 / AI-003 / AI-004)       */
/* ------------------------------------------------------------------ */

/**
 * Plans a bounded sequence of recovery actions over an enriched context
 * and structured diagnosis. Enforces strict schema validation, cost ordering,
 * prompt versioning, and deterministic safe fallback.
 *
 * Guaranteed to have zero direct side effects (only proposes actions).
 */
export async function planRecoveryDecision(
  input: PlanDecisionInput,
  customProvider?: LLMProvider
): Promise<DecisionPlan> {
  const correlationId = input.correlationId || input.context.observability.correlationId || generateUlid();
  const provider = customProvider || getLLMProvider();

  // 1. Force fallback check (AI-004)
  if (input.forceFallback) {
    logger.info({ correlationId }, '[DecisionAgent] Fallback forced by caller');
    return deriveRulesDecisionPlan(input.context, input.diagnosis, correlationId, 'FORCED_FALLBACK');
  }

  // 2. Load and render versioned prompt template (AI-010)
  let template;
  try {
    template = promptRegistry.getTemplate('recovery_decision_planner', input.promptVersion);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown template error';
    logger.warn({ correlationId, err }, `[DecisionAgent] Template error: ${errorMsg}. Engaging fallback.`);
    return deriveRulesDecisionPlan(input.context, input.diagnosis, correlationId, 'PROMPT_TEMPLATE_ERROR');
  }

  const rendered = renderPrompt(template, {
    contextJson: JSON.stringify(input.context, null, 2),
    diagnosisJson: JSON.stringify(input.diagnosis, null, 2)
  });

  const startTime = Date.now();
  let repairAttempted = false;

  try {
    // 3. Primary LLM Provider invocation (AI-001 / AI-006)
    const response = await provider.complete({
      task: 'decision',
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

    let validationResult = DecisionRawOutputSchema.safeParse(rawData);

    // 4. Bounded repair attempt on schema validation failure (AI-003)
    if (!validationResult.success) {
      repairAttempted = true;
      const formattedErrors = JSON.stringify(validationResult.error.format(), null, 2);
      logger.warn(
        { correlationId, errors: formattedErrors },
        '[DecisionAgent] Initial completion failed schema validation. Attempting single repair.'
      );

      const repairPrompt = REPAIR_DECISION_PROMPT_TEMPLATE
        .replace('{{validationErrors}}', formattedErrors)
        .replace('{{contextJson}}', JSON.stringify(input.context, null, 2))
        .replace('{{diagnosisJson}}', JSON.stringify(input.diagnosis, null, 2));

      try {
        const repairResponse = await provider.complete({
          task: 'decision',
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

        validationResult = DecisionRawOutputSchema.safeParse(repairedData);
      } catch (repairErr) {
        logger.warn(
          { correlationId, err: repairErr },
          '[DecisionAgent] Repair attempt failed. Engaging deterministic fallback.'
        );
        return deriveRulesDecisionPlan(input.context, input.diagnosis, correlationId, 'REPAIR_ATTEMPT_FAILED');
      }
    }

    // 5. If validation still failed after repair, fallback to rules engine
    if (!validationResult.success) {
      logger.warn(
        { correlationId, errors: validationResult.error.errors },
        '[DecisionAgent] Completion failed validation after repair. Engaging deterministic fallback.'
      );
      return deriveRulesDecisionPlan(input.context, input.diagnosis, correlationId, 'SCHEMA_VALIDATION_FAILED');
    }

    const decision: DecisionRawOutput = validationResult.data;
    const latencyMs = Date.now() - startTime;
    const primaryAction = decision.actions.length > 0 ? decision.actions[0] : null;

    // 6. Build final structured result with complete provenance (AI-006 / AI-008)
    return {
      planRationale: decision.planRationale,
      actions: decision.actions,
      primaryAction,
      costOrderingRespect: decision.costOrderingRespect,
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
        diagnosisCategory: input.diagnosis.category,
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
      `[DecisionAgent] LLM provider error (${errorMsg}). Engaging deterministic rules fallback.`
    );
    return deriveRulesDecisionPlan(input.context, input.diagnosis, correlationId, errorMsg);
  }
}
