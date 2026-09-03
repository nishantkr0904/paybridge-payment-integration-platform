import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock,
  Download,
  Layers,
  ListOrdered,
  RefreshCw,
  Search,
  Shield,
  User,
  X,
  XCircle
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  listRecoveryCases,
  getPrioritizedQueue,
  getCaseTimeline,
  getCaseTraces,
  executeOperatorAction,
  exportCaseAuditTrail,
  type CaseStatus,
  type RecoveryCase,
  type CaseEvent,
  type AgentTrace,
  type OperatorActionType,
  type PrioritizedCase
} from '../api/recovery';

const STATUS_BADGES: Record<CaseStatus, { label: string; style: string }> = {
  detected: { label: 'Detected', style: 'bg-purple-50 text-purple-700 border-purple-200' },
  diagnosing: { label: 'Diagnosing', style: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  scoring: { label: 'Scoring', style: 'bg-blue-50 text-blue-700 border-blue-200' },
  deciding: { label: 'Deciding', style: 'bg-sky-50 text-sky-700 border-sky-200' },
  awaiting_approval: {
    label: 'Requires Human Approval',
    style: 'bg-amber-100 text-amber-900 border-amber-300 font-semibold'
  },
  executing: { label: 'Executing', style: 'bg-blue-100 text-blue-800 border-blue-300' },
  awaiting_outcome: { label: 'Awaiting Outcome', style: 'bg-teal-50 text-teal-700 border-teal-200' },
  recovered: { label: 'Recovered', style: 'bg-emerald-50 text-emerald-800 border-emerald-300 font-medium' },
  unrecovered: { label: 'Unrecovered', style: 'bg-rose-50 text-rose-800 border-rose-300' },
  suppressed: { label: 'Suppressed', style: 'bg-slate-100 text-slate-700 border-slate-300' },
  expired: { label: 'Expired', style: 'bg-slate-100 text-slate-600 border-slate-200' },
  failed: { label: 'Failed', style: 'bg-red-100 text-red-800 border-red-300' }
};

const TERMINAL_STATUSES: CaseStatus[] = ['recovered', 'unrecovered', 'suppressed', 'expired', 'failed'];

function formatMinorUnits(minorUnits: number, currency: string = 'INR'): string {
  const major = minorUnits / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: currency.toUpperCase()
  }).format(major);
}

export function RecoveryPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Navigation / Filter State
  const [viewMode, setViewMode] = useState<'queue' | 'all'>('queue');
  const [statusFilter, setStatusFilter] = useState<CaseStatus | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCase, setSelectedCase] = useState<RecoveryCase | null>(null);

  // Operator Action Modal State
  const [actionModal, setActionModal] = useState<{
    isOpen: boolean;
    caseId: number;
    action: OperatorActionType;
    title: string;
  } | null>(null);
  const [actionReason, setActionReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  // Fetch Prioritized Triage Queue
  const queueQuery = useQuery({
    queryKey: ['recovery-queue'],
    queryFn: () => getPrioritizedQueue({ limit: 50 }),
    enabled: viewMode === 'queue'
  });

  // Fetch All Cases with Filter
  const casesQuery = useQuery({
    queryKey: ['recovery-cases', statusFilter],
    queryFn: () =>
      listRecoveryCases({
        status: statusFilter === 'all' ? undefined : statusFilter,
        limit: 50
      }),
    enabled: viewMode === 'all'
  });

  // Fetch Selected Case Timeline
  const timelineQuery = useQuery({
    queryKey: ['recovery-timeline', selectedCase?.id],
    queryFn: () => getCaseTimeline(selectedCase!.id),
    enabled: !!selectedCase
  });

  // Fetch Selected Case Traces
  const tracesQuery = useQuery({
    queryKey: ['recovery-traces', selectedCase?.id],
    queryFn: () => getCaseTraces(selectedCase!.id),
    enabled: !!selectedCase
  });

  // Operator Action Mutation
  const actionMutation = useMutation({
    mutationFn: async ({
      caseId,
      action,
      reason
    }: {
      caseId: number;
      action: OperatorActionType;
      reason: string;
    }) => {
      return executeOperatorAction(caseId, action, reason);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['recovery-queue'] });
      queryClient.invalidateQueries({ queryKey: ['recovery-cases'] });
      queryClient.invalidateQueries({ queryKey: ['recovery-timeline', data.case.id] });
      setSelectedCase(data.case);
      setActionModal(null);
      setActionReason('');
      setActionError(null);
    },
    onError: (err: unknown) => {
      const errorObj = err as { response?: { data?: { error?: { message?: string } } }; message?: string };
      const msg = errorObj.response?.data?.error?.message || errorObj.message || 'Action execution failed.';
      setActionError(msg);
    }
  });

  const handleOpenActionModal = (caseId: number, action: OperatorActionType, title: string) => {
    setActionError(null);
    setActionReason('');
    setActionModal({ isOpen: true, caseId, action, title });
  };

  const handleExecuteAction = (e: React.FormEvent) => {
    e.preventDefault();
    if (!actionReason.trim()) {
      setActionError('A mandatory reason must be provided for operator audit compliance.');
      return;
    }
    if (actionModal) {
      actionMutation.mutate({
        caseId: actionModal.caseId,
        action: actionModal.action,
        reason: actionReason.trim()
      });
    }
  };

  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async (format: 'csv' | 'json') => {
    if (!selectedCase) return;
    try {
      setIsExporting(true);
      const result = await exportCaseAuditTrail(selectedCase.id, format);
      const blob = new Blob([result.content], { type: result.contentType });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename || `audit-case-${selectedCase.caseRef}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err: unknown) {
      const errorObj = err as { response?: { data?: { error?: { message?: string } } }; message?: string };
      const msg = errorObj.response?.data?.error?.message || errorObj.message || 'Audit export failed.';
      alert(`Export error: ${msg}`);
    } finally {
      setIsExporting(false);
    }
  };

  // Filter cases by search query (caseRef, orderId, failureCategory)
  const filterList = <T extends { caseRef?: string; id?: number; failureCategory?: string | null }>(
    items: T[]
  ) => {
    if (!searchQuery.trim()) return items;
    const q = searchQuery.toLowerCase().trim();
    return items.filter(
      (item) =>
        item.caseRef?.toLowerCase().includes(q) ||
        String(item.id).includes(q) ||
        item.failureCategory?.toLowerCase().includes(q)
    );
  };

  const activeQueue = filterList(
    (queueQuery.data?.queue ?? []).map((q: PrioritizedCase) => ({
      ...q.case,
      priorityScore: q.priorityScore,
      rankReason: q.rankReason
    }))
  );

  const activeCases = filterList(casesQuery.data?.cases ?? []);

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      {/* Top Header */}
      <header className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => navigate('/dashboard')}
              className="inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-slate-900"
            >
              <ArrowLeft size={16} />
              Dashboard
            </button>
            <span className="text-slate-300">/</span>
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-slate-900 text-white">
                <Shield size={18} />
              </div>
              <div>
                <h1 className="text-lg font-bold text-slate-900">Recovery Cockpit</h1>
                <p className="text-xs text-slate-500">Autonomous Payment Recovery & Triage</p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                queryClient.invalidateQueries({ queryKey: ['recovery-queue'] });
                queryClient.invalidateQueries({ queryKey: ['recovery-cases'] });
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <RefreshCw size={14} className={queueQuery.isFetching || casesQuery.isFetching ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <div className="mx-auto max-w-7xl px-6 py-8">
        {/* Controls Bar: View Toggle & Search */}
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
            <button
              type="button"
              onClick={() => setViewMode('queue')}
              className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                viewMode === 'queue'
                  ? 'bg-slate-900 text-white shadow'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <ListOrdered size={16} />
              Prioritized Triage Queue
              {queueQuery.data?.total ? (
                <span className="ml-1 rounded-full bg-amber-500 px-2 py-0.5 text-xs font-semibold text-white">
                  {queueQuery.data.total}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              onClick={() => setViewMode('all')}
              className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                viewMode === 'all'
                  ? 'bg-slate-900 text-white shadow'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Layers size={16} />
              All Cases
            </button>
          </div>

          <div className="flex items-center gap-3">
            <div className="relative w-72">
              <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search reference or category..."
                className="w-full rounded-md border border-slate-200 bg-white py-2 pl-9 pr-4 text-sm text-slate-900 placeholder-slate-400 focus:border-slate-900 focus:outline-none"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Sub-Filters for 'All Cases' Mode */}
        {viewMode === 'all' && (
          <div className="mb-6 flex flex-wrap gap-2">
            {[
              { key: 'all' as const, label: 'All Statuses' },
              { key: 'awaiting_approval' as const, label: 'Requires Human Approval' },
              { key: 'detected' as const, label: 'Detected' },
              { key: 'executing' as const, label: 'Executing' },
              { key: 'recovered' as const, label: 'Recovered' },
              { key: 'unrecovered' as const, label: 'Unrecovered' },
              { key: 'suppressed' as const, label: 'Suppressed' }
            ].map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setStatusFilter(f.key)}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${
                  statusFilter === f.key
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-400'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}

        {/* Triage Queue Table */}
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm text-slate-600">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase text-slate-500">
              <tr>
                <th className="px-6 py-3">Case Reference</th>
                <th className="px-6 py-3">Status</th>
                <th className="px-6 py-3">Recoverable Value</th>
                <th className="px-6 py-3">Failure Category</th>
                {viewMode === 'queue' && <th className="px-6 py-3">Triage Priority</th>}
                <th className="px-6 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {(viewMode === 'queue' ? activeQueue : activeCases).length === 0 ? (
                <tr>
                  <td colSpan={viewMode === 'queue' ? 6 : 5} className="py-12 text-center text-slate-400">
                    <CheckCircle2 size={32} className="mx-auto mb-2 text-slate-300" />
                    <p className="text-sm font-medium">No recovery cases found.</p>
                    <p className="text-xs text-slate-400">
                      {viewMode === 'queue'
                        ? 'All cases are either automated or resolved.'
                        : 'No cases match your current filters.'}
                    </p>
                  </td>
                </tr>
              ) : (
                (viewMode === 'queue' ? activeQueue : activeCases).map((c: RecoveryCase & { priorityScore?: number; rankReason?: string }) => {
                  const badge = STATUS_BADGES[c.status] || {
                    label: c.status,
                    style: 'bg-slate-100 text-slate-700'
                  };
                  const isAwaitingApproval = c.status === 'awaiting_approval';

                  return (
                    <tr
                      key={c.id}
                      onClick={() => setSelectedCase(c)}
                      className={`cursor-pointer transition-colors hover:bg-slate-50 ${
                        selectedCase?.id === c.id ? 'bg-slate-100' : ''
                      }`}
                    >
                      <td className="px-6 py-4">
                        <div className="font-mono text-xs font-semibold text-slate-900">{c.caseRef}</div>
                        <div className="text-xs text-slate-400">ID #{c.id}</div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${badge.style}`}>
                          {isAwaitingApproval && <AlertTriangle size={12} className="text-amber-600 animate-pulse" />}
                          {badge.label}
                        </span>
                      </td>
                      <td className="px-6 py-4 font-semibold text-slate-900">
                        {formatMinorUnits(c.recoverableAmount, c.currency)}
                      </td>
                      <td className="px-6 py-4 text-xs font-medium text-slate-700">
                        {c.failureCategory || 'Unclassified'}
                      </td>
                      {viewMode === 'queue' && (
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-bold text-slate-900">
                              {c.priorityScore !== undefined ? c.priorityScore.toFixed(1) : '—'}
                            </span>
                            {c.rankReason && (
                              <span className="text-xs text-slate-400 truncate max-w-xs">{c.rankReason}</span>
                            )}
                          </div>
                        </td>
                      )}
                      <td className="px-6 py-4 text-right">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedCase(c);
                          }}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-slate-900 hover:underline"
                        >
                          Inspect <ChevronRight size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Case Detail & AI Trace Drawer / Modal */}
      {selectedCase && (
        <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/40 backdrop-blur-xs">
          <div className="flex h-full w-full max-w-3xl flex-col bg-white shadow-2xl animate-in slide-in-from-right">
            {/* Drawer Header */}
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 bg-slate-50">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Case Inspection</span>
                <h2 className="font-mono text-lg font-bold text-slate-900">{selectedCase.caseRef}</h2>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleExport('csv')}
                  disabled={isExporting}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-2xs hover:bg-slate-50 disabled:opacity-50"
                  title="Export certified audit trail as CSV (AUD-006)"
                >
                  <Download size={13} />
                  Export CSV
                </button>
                <button
                  type="button"
                  onClick={() => handleExport('json')}
                  disabled={isExporting}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-2xs hover:bg-slate-50 disabled:opacity-50"
                  title="Export certified audit trail as JSON (AUD-006)"
                >
                  <Download size={13} />
                  Export JSON
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedCase(null)}
                  className="rounded-md p-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-900 ml-1"
                >
                  <X size={20} />
                </button>
              </div>
            </div>

            {/* Operator Decision Banner & Action Buttons */}
            {selectedCase.status === 'awaiting_approval' && (
              <div className="border-b border-amber-200 bg-amber-50 px-6 py-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle size={20} className="text-amber-600 mt-0.5 shrink-0" />
                  <div>
                    <h3 className="text-sm font-bold text-amber-900">Human Operator Approval Required</h3>
                    <p className="mt-1 text-xs text-amber-800">
                      The autonomous decision agent proposed a recovery action that exceeded merchant tier bounds or requires explicit authorization.
                    </p>
                    <div className="mt-3 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() =>
                          handleOpenActionModal(
                            selectedCase.id,
                            'APPROVE',
                            'Approve Recovery Action & Execute'
                          )
                        }
                        className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700"
                      >
                        <CheckCircle2 size={14} />
                        Approve & Execute
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleOpenActionModal(
                            selectedCase.id,
                            'REJECT',
                            'Reject Action & Suppress'
                          )
                        }
                        className="inline-flex items-center gap-1.5 rounded-md bg-amber-700 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-amber-800"
                      >
                        <XCircle size={14} />
                        Reject Action
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleOpenActionModal(
                            selectedCase.id,
                            'CLOSE',
                            'Close Case Administratively'
                          )
                        }
                        className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        Close Case
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Non-terminal Administrative Controls */}
            {!TERMINAL_STATUSES.includes(selectedCase.status) && selectedCase.status !== 'awaiting_approval' && (
              <div className="border-b border-slate-200 bg-slate-50 px-6 py-2.5 flex items-center justify-between">
                <span className="text-xs text-slate-500">Autonomous workflow active in status: <strong>{selectedCase.status}</strong></span>
                <button
                  type="button"
                  onClick={() =>
                    handleOpenActionModal(
                      selectedCase.id,
                      'CLOSE',
                      'Close Case Administratively'
                    )
                  }
                  className="text-xs font-medium text-rose-600 hover:text-rose-800"
                >
                  Close Case Administratively
                </button>
              </div>
            )}

            {/* Drawer Body with Tabs */}
            <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
              {/* Summary Cards */}
              <div className="grid grid-cols-3 gap-4">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <span className="text-xs text-slate-400">Recoverable Amount</span>
                  <div className="mt-1 text-base font-bold text-slate-900">
                    {formatMinorUnits(selectedCase.recoverableAmount, selectedCase.currency)}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <span className="text-xs text-slate-400">Failure Category</span>
                  <div className="mt-1 text-sm font-semibold text-slate-800">
                    {selectedCase.failureCategory || 'Unclassified'}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <span className="text-xs text-slate-400">Current Status</span>
                  <div className="mt-1">
                    <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${STATUS_BADGES[selectedCase.status]?.style}`}>
                      {STATUS_BADGES[selectedCase.status]?.label || selectedCase.status}
                    </span>
                  </div>
                </div>
              </div>

              {/* AI Reasoning Trace Transcript (AI-007 / RDB-003) */}
              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-xs">
                <div className="flex items-center gap-2 border-b border-slate-200 pb-3">
                  <Bot size={18} className="text-indigo-600" />
                  <h3 className="text-sm font-bold text-slate-900">AI Agent Reasoning Trace (AI-007)</h3>
                </div>

                {tracesQuery.isLoading ? (
                  <p className="py-4 text-xs text-slate-400">Loading agent reasoning transcript...</p>
                ) : (tracesQuery.data?.traces ?? []).length === 0 ? (
                  <p className="py-4 text-xs text-slate-400">No agent reasoning traces recorded for this case.</p>
                ) : (
                  <div className="mt-4 space-y-4">
                    {tracesQuery.data?.traces.map((trace: AgentTrace) => (
                      <div key={trace.id} className="rounded-md border border-indigo-100 bg-indigo-50/30 p-3.5 space-y-3">
                        <div className="flex items-center justify-between text-xs text-slate-500">
                          <span className="font-semibold text-indigo-900">Agent: {trace.agentType}</span>
                          <span>Latency: {trace.totalDurationMs}ms · Tokens: {trace.totalInputTokens + trace.totalOutputTokens}</span>
                        </div>

                        {trace.steps.map((step) => (
                          <div key={step.stepNumber} className="rounded-md border border-slate-200 bg-white p-3 space-y-2 text-xs">
                            <div className="flex items-center justify-between font-semibold text-slate-700">
                              <span>Step {step.stepNumber}: {step.stepType}</span>
                              <span className="text-slate-400">{step.modelId || 'deterministic'}</span>
                            </div>

                            {step.userPrompt && (
                              <div className="rounded bg-slate-50 p-2 text-slate-600 font-mono text-[11px]">
                                <span className="font-bold text-slate-700">User Prompt (Masked PII):</span>
                                <pre className="mt-1 whitespace-pre-wrap">{step.userPrompt}</pre>
                              </div>
                            )}

                            {step.parsedOutput && (
                              <div className="rounded bg-emerald-50/50 p-2 text-emerald-900 font-mono text-[11px] border border-emerald-100">
                                <span className="font-bold text-emerald-800">Parsed Output:</span>
                                <pre className="mt-1 whitespace-pre-wrap">{JSON.stringify(step.parsedOutput, null, 2)}</pre>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Event Timeline Narrative (RDB-002) */}
              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-xs">
                <div className="flex items-center gap-2 border-b border-slate-200 pb-3">
                  <Clock size={18} className="text-slate-700" />
                  <h3 className="text-sm font-bold text-slate-900">Case Event Timeline (RDB-002)</h3>
                </div>

                {timelineQuery.isLoading ? (
                  <p className="py-4 text-xs text-slate-400">Loading timeline narrative...</p>
                ) : (timelineQuery.data?.timeline ?? []).length === 0 ? (
                  <p className="py-4 text-xs text-slate-400">No events recorded.</p>
                ) : (
                  <div className="mt-4 flow-root">
                    <ul className="-mb-8">
                      {timelineQuery.data?.timeline.map((event: CaseEvent, idx: number) => {
                        const isLast = idx === timelineQuery.data!.timeline.length - 1;
                        return (
                          <li key={event.id}>
                            <div className="relative pb-6">
                              {!isLast && (
                                <span className="absolute left-4 top-4 -ml-px h-full w-0.5 bg-slate-200" aria-hidden="true" />
                              )}
                              <div className="relative flex items-start space-x-3">
                                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 ring-4 ring-white">
                                  {event.actorType === 'agent' ? (
                                    <Bot size={14} className="text-indigo-600" />
                                  ) : event.actorType === 'operator' ? (
                                    <User size={14} className="text-amber-600" />
                                  ) : (
                                    <Shield size={14} className="text-slate-600" />
                                  )}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="text-xs">
                                    <span className="font-semibold text-slate-900">
                                      {event.actorId || event.actorType}
                                    </span>{' '}
                                    <span className="text-slate-500">
                                      transitioned case {event.fromStatus ? `from ${event.fromStatus}` : ''} to{' '}
                                      <strong className="text-slate-800">{event.toStatus}</strong>
                                    </span>
                                  </div>
                                  {event.reason && (
                                    <p className="mt-1 text-xs text-slate-600 bg-slate-50 rounded p-1.5 border border-slate-100">
                                      {event.reason}
                                    </p>
                                  )}
                                  <span className="text-[10px] text-slate-400">
                                    {new Date(event.createdAt).toLocaleString()}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Operator Action Modal */}
      {actionModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl animate-in zoom-in-95">
            <h3 className="text-base font-bold text-slate-900">{actionModal.title}</h3>
            <p className="mt-1 text-xs text-slate-500">
              State-changing operator interventions require a mandatory reason for compliance and audit trail records.
            </p>

            {actionError && (
              <div className="mt-3 rounded-md bg-rose-50 p-2.5 text-xs text-rose-700 border border-rose-200">
                {actionError}
              </div>
            )}

            <form onSubmit={handleExecuteAction} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Reason for Action *
                </label>
                <textarea
                  rows={3}
                  value={actionReason}
                  onChange={(e) => setActionReason(e.target.value)}
                  placeholder="e.g. Verified customer credit limit replenishment via merchant support"
                  className="w-full rounded-md border border-slate-300 p-2.5 text-xs text-slate-900 placeholder-slate-400 focus:border-slate-900 focus:outline-none"
                  required
                />
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setActionModal(null)}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionMutation.isPending}
                  className={`inline-flex items-center gap-1.5 rounded-md px-4 py-1.5 text-xs font-semibold text-white shadow-sm ${
                    actionModal.action === 'APPROVE'
                      ? 'bg-emerald-600 hover:bg-emerald-700'
                      : 'bg-rose-600 hover:bg-rose-700'
                  }`}
                >
                  {actionMutation.isPending ? 'Executing...' : 'Confirm Action'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}
