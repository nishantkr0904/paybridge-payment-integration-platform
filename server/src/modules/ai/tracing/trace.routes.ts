import { Router } from 'express';
import { authenticate } from '../../../middleware/authenticate.js';
import {
  getOperatorTrace,
  replayAgentTrace,
  findTracesByCaseId,
  findTracesByCorrelationId
} from './trace.service.js';

export const traceRouter = Router();

traceRouter.use(authenticate);

/* GET /api/v1/ops/agent-traces/:traceRef — operator trace inspection */
traceRouter.get('/:traceRef', async (req, res, next) => {
  try {
    const trace = await getOperatorTrace(req.params.traceRef);
    res.json(trace);
  } catch (error) {
    next(error);
  }
});

/* POST /api/v1/ops/agent-traces/:traceRef/replay — deterministic trace replay */
traceRouter.post('/:traceRef/replay', async (req, res, next) => {
  try {
    const result = await replayAgentTrace(req.params.traceRef);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/* GET /api/v1/ops/agent-traces/by-case/:caseId — list traces by case */
traceRouter.get('/by-case/:caseId', async (req, res, next) => {
  try {
    const caseId = Number(req.params.caseId);
    const traces = await findTracesByCaseId(caseId);
    res.json(traces);
  } catch (error) {
    next(error);
  }
});

/* GET /api/v1/ops/agent-traces/by-correlation/:correlationId — list traces by correlation ID */
traceRouter.get('/by-correlation/:correlationId', async (req, res, next) => {
  try {
    const traces = await findTracesByCorrelationId(req.params.correlationId);
    res.json(traces);
  } catch (error) {
    next(error);
  }
});
