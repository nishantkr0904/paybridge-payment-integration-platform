import { FormEvent, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { createOrder } from '../api/payment';

export function CreateOrderPage() {
  const navigate = useNavigate();
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [description, setDescription] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      createOrder({
        amount: parseFloat(amount),
        currency,
        description: description || undefined,
        customerEmail: customerEmail || undefined
      }),
    onSuccess(order) {
      navigate(`/payments/${order.orderRef}`);
    }
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <section className="mx-auto max-w-2xl px-6 py-8">
      <button
        type="button"
        className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-ink"
        onClick={() => navigate('/payments')}
      >
        <ArrowLeft size={16} aria-hidden="true" />
        Back to payments
      </button>

      <h2 className="mb-6 text-2xl font-semibold text-ink">Create checkout order</h2>

      <div className="rounded-md border border-line bg-white p-6">
        <form className="space-y-4" onSubmit={submit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Amount</span>
              <input
                className="mt-1 w-full rounded-md border border-line px-3 py-2 outline-none focus:border-ink"
                type="number"
                step="0.01"
                min="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="999.50"
                required
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-slate-700">Currency</span>
              <select
                className="mt-1 w-full rounded-md border border-line px-3 py-2 outline-none focus:border-ink"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                <option value="INR">INR</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
              </select>
            </label>
          </div>

          <label className="block">
            <span className="text-sm font-medium text-slate-700">Description</span>
            <input
              className="mt-1 w-full rounded-md border border-line px-3 py-2 outline-none focus:border-ink"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Premium subscription"
              maxLength={255}
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-slate-700">Customer email</span>
            <input
              className="mt-1 w-full rounded-md border border-line px-3 py-2 outline-none focus:border-ink"
              type="email"
              value={customerEmail}
              onChange={(e) => setCustomerEmail(e.target.value)}
              placeholder="buyer@example.com"
            />
          </label>

          {mutation.isError ? (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              Failed to create order. Please check your input and try again.
            </p>
          ) : null}

          <button
            className="w-full rounded-md bg-ink px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
            type="submit"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'Creating...' : 'Create order'}
          </button>
        </form>
      </div>
    </section>
  );
}
