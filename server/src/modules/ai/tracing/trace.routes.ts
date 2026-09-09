import { Router } from 'express';
import { authenticate } from '../../../middleware/authenticate.js';
import { requirePermission } from '../../../middleware/authorize.js';
import {
  getOperatorTrace,
  replayAgentTrace,
  findTracesByCaseId,
  findTracesByCorrelationId
} from './trace.service.js';

export const traceRouter = Router();

traceRouter.use(authenticate);

/* GET /api/v1/ops/agent-traces/:traceRef — operator trace inspection */
traceRouter.get('/:traceRef', requirePermission('ops:trace:read'), async (req, res, next) => {
  try {
    const traceRef = Array.isArray(req.params.traceRef) ? req.params.traceRef[0]! : req.params.traceRef!;
    const trace = await getOperatorTrace(traceRef);
    res.json(trace);
  } catch (error) {
    next(error);
  }
});

/* POST /api/v1/ops/agent-traces/:traceRef/replay — deterministic trace replay */
traceRouter.post('/:traceRef/replay', requirePermission('ops:trace:replay'), async (req, res, next) => {
  try {
    const traceRef = Array.isArray(req.params.traceRef) ? req.params.traceRef[0]! : req.params.traceRef!;
    const result = await replayAgentTrace(traceRef);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/* GET /api/v1/ops/agent-traces/by-case/:caseId — list traces by case */
traceRouter.get('/by-case/:caseId', requirePermission('ops:trace:read'), async (req, res, next) => {
  try {
    const caseId = Number(req.params.caseId);
    const traces = await findTracesByCaseId(caseId);
    res.json(traces);
  } catch (error) {
    next(error);
  }
});

/* GET /api/v1/ops/agent-traces/by-correlation/:correlationId — list traces by correlation ID */
traceRouter.get('/by-correlation/:correlationId', requirePermission('ops:trace:read'), async (req, res, next) => {
  try {
    const correlationId = Array.isArray(req.params.correlationId)
      ? req.params.correlationId[0]!
      : req.params.correlationId!;
    const traces = await findTracesByCorrelationId(correlationId);
    res.json(traces);
  } catch (error) {
    next(error);
  }
});
