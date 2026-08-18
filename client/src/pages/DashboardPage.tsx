import { useQuery } from '@tanstack/react-query';
import { Activity, CreditCard, LogOut, ShieldCheck } from 'lucide-react';
import { getMerchantProfile } from '../api/merchant';
import { useAuth } from '../providers/AuthProvider';

export function DashboardPage() {
  const { logout, user } = useAuth();
  const profileQuery = useQuery({
    queryKey: ['merchant-profile'],
    queryFn: getMerchantProfile
  });

  const summary = profileQuery.data?.summary;
  const currentUser = profileQuery.data?.user ?? user;

  return (
    <main className="min-h-screen bg-surface">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-ink text-white">
              <ShieldCheck size={20} aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm text-slate-500">PayBridge</p>
              <h1 className="text-lg font-semibold text-ink">Merchant Dashboard</h1>
            </div>
          </div>
          <button
            className="inline-flex items-center gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-ink"
            type="button"
            onClick={logout}
          >
            <LogOut size={16} aria-hidden="true" />
            Logout
          </button>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6">
          <p className="text-sm font-medium text-slate-500">Signed in merchant</p>
          <h2 className="mt-1 text-2xl font-semibold text-ink">
            {currentUser?.merchantName ?? 'Merchant workspace'}
          </h2>
          <p className="mt-1 text-sm text-slate-600">{currentUser?.email}</p>
        </div>

        {profileQuery.isLoading ? (
          <p className="rounded-md border border-line bg-white px-4 py-3 text-sm text-slate-600">
            Loading merchant workspace...
          </p>
        ) : null}

        {profileQuery.isError ? (
          <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Unable to load protected dashboard data. Please log in again.
          </p>
        ) : null}

        <div className="grid gap-4 md:grid-cols-4">
          <SummaryTile label="Total transactions" value={summary?.totalTransactions ?? 0} />
          <SummaryTile label="Successful payments" value={summary?.successfulPayments ?? 0} />
          <SummaryTile label="Failed payments" value={summary?.failedPayments ?? 0} />
          <SummaryTile label="Pending payments" value={summary?.pendingPayments ?? 0} />
        </div>

        <div className="mt-6 rounded-md border border-line bg-white p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-surface text-ink">
              <CreditCard size={20} aria-hidden="true" />
            </div>
            <div>
              <h3 className="font-semibold text-ink">Payment workspace</h3>
              <p className="text-sm text-slate-600">
                Checkout API and transaction activity will appear here in Version 2.
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function SummaryTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-line bg-white p-4">
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-md bg-surface text-ink">
        <Activity size={18} aria-hidden="true" />
      </div>
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-ink">{value}</p>
    </div>
  );
}
