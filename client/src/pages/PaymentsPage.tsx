import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, CreditCard, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { listOrders } from '../api/payment';
import type { OrderStatus } from '../api/payment';

const STATUS_STYLES: Record<OrderStatus, string> = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  processing: 'bg-blue-50 text-blue-700 border-blue-200',
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  failed: 'bg-red-50 text-red-700 border-red-200'
};

const STATUSES: (OrderStatus | 'all')[] = ['all', 'pending', 'processing', 'success', 'failed'];

export function PaymentsPage() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<OrderStatus | 'all'>('all');
  const [page, setPage] = useState(1);
  const limit = 10;

  const ordersQuery = useQuery({
    queryKey: ['orders', statusFilter, page],
    queryFn: () =>
      listOrders({
        status: statusFilter === 'all' ? undefined : statusFilter,
        page,
        limit
      })
  });

  const orders = ordersQuery.data?.orders ?? [];
  const total = ordersQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <section className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-ink">Payments</h2>
          <p className="mt-1 text-sm text-slate-600">
            {total} order{total !== 1 ? 's' : ''} total
          </p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          onClick={() => navigate('/payments/new')}
        >
          <Plus size={16} aria-hidden="true" />
          New order
        </button>
      </div>

      <div className="mb-4 flex gap-2">
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            className={`rounded-md border px-3 py-1.5 text-sm font-medium capitalize ${
              statusFilter === s
                ? 'border-ink bg-ink text-white'
                : 'border-line bg-white text-slate-600 hover:border-ink'
            }`}
            onClick={() => {
              setStatusFilter(s);
              setPage(1);
            }}
          >
            {s}
          </button>
        ))}
      </div>

      {ordersQuery.isLoading ? (
        <p className="rounded-md border border-line bg-white px-4 py-3 text-sm text-slate-600">
          Loading orders...
        </p>
      ) : null}

      {ordersQuery.isError ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Failed to load orders. Please try again.
        </p>
      ) : null}

      {!ordersQuery.isLoading && orders.length === 0 ? (
        <div className="rounded-md border border-line bg-white p-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-md bg-surface text-ink">
            <CreditCard size={24} aria-hidden="true" />
          </div>
          <p className="font-medium text-ink">No orders yet</p>
          <p className="mt-1 text-sm text-slate-600">Create your first checkout order to get started.</p>
        </div>
      ) : null}

      {orders.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-line bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface text-left">
                <th className="px-4 py-3 font-medium text-slate-600">Order Ref</th>
                <th className="px-4 py-3 font-medium text-slate-600">Amount</th>
                <th className="px-4 py-3 font-medium text-slate-600">Status</th>
                <th className="px-4 py-3 font-medium text-slate-600">Description</th>
                <th className="px-4 py-3 font-medium text-slate-600">Created</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr
                  key={order.id}
                  className="cursor-pointer border-b border-line last:border-0 hover:bg-surface"
                  onClick={() => navigate(`/payments/${order.orderRef}`)}
                >
                  <td className="px-4 py-3 font-mono text-xs text-ink">{order.orderRef}</td>
                  <td className="px-4 py-3 font-medium text-ink">
                    {order.currency} {order.amount.toFixed(2)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded-md border px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[order.status]}`}
                    >
                      {order.status}
                    </span>
                  </td>
                  <td className="max-w-[200px] truncate px-4 py-3 text-slate-600">
                    {order.description ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {new Date(order.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {totalPages > 1 ? (
            <div className="flex items-center justify-between border-t border-line px-4 py-3">
              <p className="text-sm text-slate-500">
                Page {page} of {totalPages}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md border border-line bg-white px-3 py-1.5 text-sm text-slate-600 hover:border-ink disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft size={14} aria-hidden="true" />
                  Prev
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md border border-line bg-white px-3 py-1.5 text-sm text-slate-600 hover:border-ink disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
