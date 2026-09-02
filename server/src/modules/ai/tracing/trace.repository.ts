import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../../config/database.js';
import { generateUlid } from '../../../utils/ulid.js';
import type {
  AgentTrace,
  AgentTraceStep,
  CreateTraceInput
} from './trace.types.js';

/* ------------------------------------------------------------------ */
/*  Database Row Interfaces                                           */
/* ------------------------------------------------------------------ */

interface AgentTraceRow extends RowDataPacket {
  id: number;
  merchant_id: number;
  case_id: number;
  trace_ref: string;
  agent_type: 'diagnosis' | 'decision' | 'multi_agent';
  status: 'success' | 'failed' | 'aborted' | 'vetoed';
  termination_reason: string | null;
  total_duration_ms: number;
  total_input_tokens: number;
  total_output_tokens: number;
  correlation_id: string;
  created_at: Date;
  updated_at: Date;
}

interface AgentTraceStepRow extends RowDataPacket {
  id: number;
  trace_id: number;
  step_number: number;
  step_type: 'prompt_render' | 'model_completion' | 'schema_validation' | 'repair_attempt' | 'policy_evaluation' | 'fallback_rules';
  prompt_id: string | null;
  prompt_version: string | null;
  model_id: string | null;
  system_prompt: string | null;
  user_prompt: string | null;
  raw_response: string | null;
  parsed_output: unknown;
  validation_status: 'passed' | 'failed' | 'repaired' | 'fallback';
  validation_errors: unknown;
  tool_invoked: string | null;
  tool_arguments: unknown;
  tool_result: unknown;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  created_at: Date;
}

function toTrace(row: AgentTraceRow, steps: AgentTraceStep[] = []): AgentTrace {
  return {
    id: Number(row.id),
    merchantId: Number(row.merchant_id),
    caseId: Number(row.case_id),
    traceRef: row.trace_ref,
    agentType: row.agent_type,
    status: row.status,
    terminationReason: row.termination_reason,
    totalDurationMs: Number(row.total_duration_ms),
    totalInputTokens: Number(row.total_input_tokens),
    totalOutputTokens: Number(row.total_output_tokens),
    correlationId: row.correlation_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    steps
  };
}

function toTraceStep(row: AgentTraceStepRow): AgentTraceStep {
  return {
    id: Number(row.id),
    traceId: Number(row.trace_id),
    stepNumber: Number(row.step_number),
    stepType: row.step_type,
    promptId: row.prompt_id,
    promptVersion: row.prompt_version,
    modelId: row.model_id,
    systemPrompt: row.system_prompt,
    userPrompt: row.user_prompt,
    rawResponse: row.raw_response,
    parsedOutput: typeof row.parsed_output === 'string' ? JSON.parse(row.parsed_output) : (row.parsed_output as Record<string, unknown> | null),
    validationStatus: row.validation_status,
    validationErrors: typeof row.validation_errors === 'string' ? JSON.parse(row.validation_errors) : row.validation_errors,
    toolInvoked: row.tool_invoked,
    toolArguments: typeof row.tool_arguments === 'string' ? JSON.parse(row.tool_arguments) : (row.tool_arguments as Record<string, unknown> | null),
    toolResult: typeof row.tool_result === 'string' ? JSON.parse(row.tool_result) : (row.tool_result as Record<string, unknown> | null),
    durationMs: Number(row.duration_ms),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    createdAt: new Date(row.created_at)
  };
}

/* ------------------------------------------------------------------ */
/*  Transactional Repository Operations                              */
/* ------------------------------------------------------------------ */

/**
 * Creates an agent reasoning trace along with all its step records atomically.
 * (AI-007 / AUD-002)
 */
export async function createAgentTrace(input: CreateTraceInput): Promise<AgentTrace> {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const traceRef = input.traceRef || generateUlid();

    const [headerResult] = await conn.query<ResultSetHeader>(
      `INSERT INTO agent_traces (
        merchant_id, case_id, trace_ref, agent_type, status,
        termination_reason, total_duration_ms, total_input_tokens,
        total_output_tokens, correlation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.merchantId,
        input.caseId,
        traceRef,
        input.agentType,
        input.status,
        input.terminationReason || null,
        input.totalDurationMs || 0,
        input.totalInputTokens || 0,
        input.totalOutputTokens || 0,
        input.correlationId
      ]
    );

    const traceId = headerResult.insertId;
    const insertedSteps: AgentTraceStep[] = [];

    for (const step of input.steps) {
      const [stepResult] = await conn.query<ResultSetHeader>(
        `INSERT INTO agent_trace_steps (
          trace_id, step_number, step_type, prompt_id, prompt_version,
          model_id, system_prompt, user_prompt, raw_response, parsed_output,
          validation_status, validation_errors, tool_invoked, tool_arguments,
          tool_result, duration_ms, input_tokens, output_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          traceId,
          step.stepNumber,
          step.stepType,
          step.promptId || null,
          step.promptVersion || null,
          step.modelId || null,
          step.systemPrompt || null,
          step.userPrompt || null,
          step.rawResponse || null,
          step.parsedOutput ? JSON.stringify(step.parsedOutput) : null,
          step.validationStatus || 'passed',
          step.validationErrors ? JSON.stringify(step.validationErrors) : null,
          step.toolInvoked || null,
          step.toolArguments ? JSON.stringify(step.toolArguments) : null,
          step.toolResult ? JSON.stringify(step.toolResult) : null,
          step.durationMs || 0,
          step.inputTokens || 0,
          step.outputTokens || 0
        ]
      );

      insertedSteps.push({
        ...step,
        id: stepResult.insertId,
        traceId,
        validationStatus: step.validationStatus || 'passed',
        durationMs: step.durationMs || 0,
        inputTokens: step.inputTokens || 0,
        outputTokens: step.outputTokens || 0,
        createdAt: new Date()
      });
    }

    await conn.commit();

    return {
      id: traceId,
      merchantId: input.merchantId,
      caseId: input.caseId,
      traceRef,
      agentType: input.agentType,
      status: input.status,
      terminationReason: input.terminationReason || null,
      totalDurationMs: input.totalDurationMs || 0,
      totalInputTokens: input.totalInputTokens || 0,
      totalOutputTokens: input.totalOutputTokens || 0,
      correlationId: input.correlationId,
      createdAt: new Date(),
      updatedAt: new Date(),
      steps: insertedSteps
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Finds a trace by ID with full tenant scoping.
 */
export async function findTraceById(id: number, merchantId?: number): Promise<AgentTrace | null> {
  let query = 'SELECT * FROM agent_traces WHERE id = ?';
  const params: unknown[] = [id];

  if (merchantId !== undefined) {
    query += ' AND merchant_id = ?';
    params.push(merchantId);
  }

  const [rows] = await pool.query<AgentTraceRow[]>(query, params);
  if (rows.length === 0) return null;

  const [stepRows] = await pool.query<AgentTraceStepRow[]>(
    'SELECT * FROM agent_trace_steps WHERE trace_id = ? ORDER BY step_number ASC',
    [id]
  );

  return toTrace(rows[0]!, stepRows.map(toTraceStep));
}

/**
 * Finds a trace by public ULID reference with optional merchant scoping.
 */
export async function findTraceByRef(traceRef: string, merchantId?: number): Promise<AgentTrace | null> {
  let query = 'SELECT * FROM agent_traces WHERE trace_ref = ?';
  const params: unknown[] = [traceRef];

  if (merchantId !== undefined) {
    query += ' AND merchant_id = ?';
    params.push(merchantId);
  }

  const [rows] = await pool.query<AgentTraceRow[]>(query, params);
  if (rows.length === 0) return null;

  const traceId = rows[0]!.id;
  const [stepRows] = await pool.query<AgentTraceStepRow[]>(
    'SELECT * FROM agent_trace_steps WHERE trace_id = ? ORDER BY step_number ASC',
    [traceId]
  );

  return toTrace(rows[0]!, stepRows.map(toTraceStep));
}

/**
 * Lists all traces for a recovery case.
 */
export async function findTracesByCaseId(caseId: number, merchantId?: number): Promise<AgentTrace[]> {
  let query = 'SELECT * FROM agent_traces WHERE case_id = ?';
  const params: unknown[] = [caseId];

  if (merchantId !== undefined) {
    query += ' AND merchant_id = ?';
    params.push(merchantId);
  }

  query += ' ORDER BY id DESC';

  const [rows] = await pool.query<AgentTraceRow[]>(query, params);
  if (rows.length === 0) return [];

  const traces: AgentTrace[] = [];
  for (const row of rows) {
    const [stepRows] = await pool.query<AgentTraceStepRow[]>(
      'SELECT * FROM agent_trace_steps WHERE trace_id = ? ORDER BY step_number ASC',
      [row.id]
    );
    traces.push(toTrace(row, stepRows.map(toTraceStep)));
  }

  return traces;
}

/**
 * Finds traces by correlation ID.
 */
export async function findTracesByCorrelationId(correlationId: string): Promise<AgentTrace[]> {
  const [rows] = await pool.query<AgentTraceRow[]>(
    'SELECT * FROM agent_traces WHERE correlation_id = ? ORDER BY id ASC',
    [correlationId]
  );

  const traces: AgentTrace[] = [];
  for (const row of rows) {
    const [stepRows] = await pool.query<AgentTraceStepRow[]>(
      'SELECT * FROM agent_trace_steps WHERE trace_id = ? ORDER BY step_number ASC',
      [row.id]
    );
    traces.push(toTrace(row, stepRows.map(toTraceStep)));
  }

  return traces;
}
