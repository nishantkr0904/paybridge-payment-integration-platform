import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { getOrder, processPayment } from '../api/payment';
import type { OrderStatus, PaymentMethod } from '../api/payment';

const STATUS_STYLES: Record<OrderStatus, string> = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  processing: 'bg-blue-50 text-blue-700 border-blue-200',
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  failed: 'bg-red-50 text-red-700 border-red-200'
};

const STATUS_ICONS: Record<OrderStatus, typeof CheckCircle2> = {
  pending: Clock,
  processing: Loader2,
  success: CheckCircle2,
  failed: XCircle
};

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'card', label: 'Credit / Debit Card' },
  { value: 'upi', label: 'UPI' },
  { value: 'netbanking', label: 'Net Banking' },
  { value: 'wallet', label: 'Wallet' }
];

export function OrderDetailPage() {
  const { orderRef } = useParams<{ orderRef: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethod>('card');

  const orderQuery = useQuery({
    queryKey: ['order', orderRef],
    queryFn: () => getOrder(orderRef!),
    enabled: !!orderRef
  });

  const payMutation = useMutation({
    mutationFn: () => processPayment(orderRef!, { paymentMethod: selectedMethod }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['order', orderRef] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
    }
  });

  const order = orderQuery.data?.order;
  const transactions = orderQuery.data?.transactions ?? [];
  const canPay = order?.status === 'pending' || order?.status === 'failed';

  if (orderQuery.isLoading) {
    return (
      <section className="mx-auto max-w-3xl px-6 py-8">
        <p className="rounded-md border border-line bg-white px-4 py-3 text-sm text-slate-600">
          Loading order details...
        </p>
      </section>
    );
  }

  if (orderQuery.isError || !order) {
    return (
      <section className="mx-auto max-w-3xl px-6 py-8">
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Order not found or could not be loaded.
        </p>
      </section>
    );
  }

  const StatusIcon = STATUS_ICONS[order.status];

  return (
    <section className="mx-auto max-w-3xl px-6 py-8">
      <button
        type="button"
        className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-ink"
        onClick={() => navigate('/payments')}
      >
        <ArrowLeft size={16} aria-hidden="true" />
        Back to payments
      </button>

      {/* Order header */}
      <div className="mb-6 rounded-md border border-line bg-white p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-slate-500">Order</p>
            <p className="mt-0.5 font-mono text-sm text-ink">{order.orderRef}</p>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium capitalize ${STATUS_STYLES[order.status]}`}
          >
            <StatusIcon size={14} aria-hidden="true" />
            {order.status}
          </span>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-sm text-slate-500">Amount</p>
            <p className="mt-0.5 text-lg font-semibold text-ink">
              {order.currency} {order.amount.toFixed(2)}
            </p>
          </div>
          <div>
            <p className="text-sm text-slate-500">Description</p>
            <p className="mt-0.5 text-sm text-ink">{order.description ?? '—'}</p>
          </div>
          <div>
            <p className="text-sm text-slate-500">Customer</p>
            <p className="mt-0.5 text-sm text-ink">{order.customerEmail ?? '—'}</p>
          </div>
        </div>

        <div className="mt-3 text-xs text-slate-400">
          Created {new Date(order.createdAt).toLocaleString()}
        </div>
      </div>

      {/* Payment form — only show if order is payable */}
      {canPay ? (
        <div className="mb-6 rounded-md border border-line bg-white p-5">
          <h3 className="mb-3 font-semibold text-ink">Process payment</h3>

          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {PAYMENT_METHODS.map((m) => (
              <button
                key={m.value}
                type="button"
                className={`rounded-md border px-3 py-2 text-sm font-medium ${
                  selectedMethod === m.value
                    ? 'border-ink bg-ink text-white'
                    : 'border-line bg-white text-slate-600 hover:border-ink'
                }`}
                onClick={() => setSelectedMethod(m.value)}
              >
                {m.label}
              </button>
            ))}
          </div>

          {payMutation.isSuccess ? (
            <div
              className={`mb-3 rounded-md border px-3 py-2 text-sm ${
                payMutation.data.status === 'success'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-red-200 bg-red-50 text-red-700'
              }`}
            >
              {payMutation.data.status === 'success'
                ? `Payment successful — Txn ${payMutation.data.txnRef}`
                : `Payment failed — ${payMutation.data.failureReason}`}
            </div>
          ) : null}

          {payMutation.isError ? (
            <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              Payment processing error. Please try again.
            </p>
          ) : null}

          <button
            type="button"
            className="w-full rounded-md bg-ink px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={payMutation.isPending}
            onClick={() => payMutation.mutate()}
          >
            {payMutation.isPending ? 'Processing...' : `Pay ${order.currency} ${order.amount.toFixed(2)}`}
          </button>
        </div>
      ) : null}

      {/* Transaction history */}
      <div className="rounded-md border border-line bg-white">
        <div className="border-b border-line px-5 py-3">
          <h3 className="font-semibold text-ink">
            Transaction history ({transactions.length})
          </h3>
        </div>

        {transactions.length === 0 ? (
          <p className="px-5 py-4 text-sm text-slate-500">No payment attempts yet.</p>
        ) : (
          <div className="divide-y divide-line">
            {transactions.map((txn) => (
              <div key={txn.id} className="px-5 py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-mono text-xs text-ink">{txn.txnRef}</p>
                    <p className="mt-0.5 text-sm text-slate-500 capitalize">
                      {txn.paymentMethod} · {new Date(txn.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <span
                    className={`rounded-md border px-2 py-0.5 text-xs font-medium capitalize ${
                      STATUS_STYLES[txn.status as OrderStatus] ?? 'bg-slate-50 text-slate-600 border-slate-200'
                    }`}
                  >
                    {txn.status}
                  </span>
                </div>
                {txn.failureReason ? (
                  <p className="mt-1 text-xs text-red-600">{txn.failureReason}</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
