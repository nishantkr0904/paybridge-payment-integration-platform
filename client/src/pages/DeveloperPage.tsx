import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getWebhookEndpoints, getWebhookDeliveries, addWebhookEndpoint } from '../api/webhook.js';

import { useNavigate } from 'react-router-dom';
import { useAuth } from '../providers/AuthProvider';
import { CreditCard, LogOut, ShieldCheck, Code2 } from 'lucide-react';

export function DeveloperPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [url, setUrl] = useState('http://localhost:4000/api/webhooks/test-listener');
  const [showSecret, setShowSecret] = useState<Record<number, boolean>>({});

  const { data: endpointsData, isLoading: loadingEndpoints } = useQuery({
    queryKey: ['webhookEndpoints'],
    queryFn: getWebhookEndpoints
  });

  const { data: deliveriesData, isLoading: loadingDeliveries } = useQuery({
    queryKey: ['webhookDeliveries'],
    queryFn: getWebhookDeliveries,
    refetchInterval: 5000 // Poll every 5s to see new webhook deliveries
  });

  const addEndpointMutation = useMutation({
    mutationFn: addWebhookEndpoint,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhookEndpoints'] });
      setUrl('');
    }
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;
    addEndpointMutation.mutate(url);
  };

  const toggleSecret = (id: number) => {
    setShowSecret(prev => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <main className="min-h-screen bg-surface">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => navigate('/dashboard')}>
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-ink text-white">
              <ShieldCheck size={20} aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm text-slate-500">PayBridge</p>
              <h1 className="text-lg font-semibold text-ink">Developer Portal</h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              className="inline-flex items-center gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-ink"
              type="button"
              onClick={() => navigate('/payments')}
            >
              <CreditCard size={16} aria-hidden="true" />
              Payments
            </button>
            <button
              className="inline-flex items-center gap-2 rounded-md border border-ink bg-white px-3 py-2 text-sm font-medium text-slate-900"
              type="button"
            >
              <Code2 size={16} aria-hidden="true" />
              Developers
            </button>
            <button
              className="inline-flex items-center gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-ink"
              type="button"
              onClick={logout}
            >
              <LogOut size={16} aria-hidden="true" />
              Logout
            </button>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-6 py-8">
        <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Developer Settings</h1>
      </div>

      <div className="bg-white shadow-sm ring-1 ring-gray-900/5 sm:rounded-xl md:col-span-2">
        <div className="px-4 py-6 sm:p-8">
          <h2 className="text-base font-semibold leading-7 text-gray-900">Webhooks</h2>
          <p className="mt-1 text-sm leading-6 text-gray-500">
            Subscribe to payment events to receive real-time updates.
          </p>

          <form onSubmit={handleSubmit} className="mt-6 flex max-w-md gap-x-4">
            <input
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-domain.com/webhook"
              className="min-w-0 flex-auto rounded-md border-0 px-3.5 py-2 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6"
            />
            <button
              type="submit"
              disabled={addEndpointMutation.isPending}
              className="flex-none rounded-md bg-indigo-600 px-3.5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-50"
            >
              Add Endpoint
            </button>
          </form>

          {loadingEndpoints ? (
            <p className="mt-4 text-sm text-gray-500">Loading endpoints...</p>
          ) : (
            <div className="mt-8 flow-root">
              <div className="-mx-4 -my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
                <div className="inline-block min-w-full py-2 align-middle sm:px-6 lg:px-8">
                  <table className="min-w-full divide-y divide-gray-300">
                    <thead>
                      <tr>
                        <th className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 sm:pl-0">URL</th>
                        <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Signing Secret</th>
                        <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {endpointsData?.endpoints.map((endpoint) => (
                        <tr key={endpoint.id}>
                          <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm font-medium text-gray-900 sm:pl-0">
                            {endpoint.url}
                          </td>
                          <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                            <div className="flex items-center gap-2">
                              <span className="font-mono bg-gray-50 px-2 py-1 rounded border">
                                {showSecret[endpoint.id] ? endpoint.secret : 'whsec_••••••••••••••••••••••••'}
                              </span>
                              <button
                                onClick={() => toggleSecret(endpoint.id)}
                                className="text-indigo-600 hover:text-indigo-900 text-xs font-medium"
                              >
                                {showSecret[endpoint.id] ? 'Hide' : 'Reveal'}
                              </button>
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                            <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${
                              endpoint.isActive ? 'bg-green-50 text-green-700 ring-green-600/20' : 'bg-red-50 text-red-700 ring-red-600/20'
                            }`}>
                              {endpoint.isActive ? 'Active' : 'Disabled'}
                            </span>
                          </td>
                        </tr>
                      ))}
                      {(!endpointsData?.endpoints || endpointsData.endpoints.length === 0) && (
                        <tr>
                          <td colSpan={3} className="py-4 text-sm text-gray-500 text-center">No webhook endpoints configured.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="bg-white shadow-sm ring-1 ring-gray-900/5 sm:rounded-xl md:col-span-2">
        <div className="px-4 py-6 sm:p-8">
          <h2 className="text-base font-semibold leading-7 text-gray-900">Recent Deliveries</h2>
          
          {loadingDeliveries ? (
            <p className="mt-4 text-sm text-gray-500">Loading deliveries...</p>
          ) : (
            <div className="mt-6 flow-root">
              <div className="-mx-4 -my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
                <div className="inline-block min-w-full py-2 align-middle sm:px-6 lg:px-8">
                  <table className="min-w-full divide-y divide-gray-300">
                    <thead>
                      <tr>
                        <th className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 sm:pl-0">Event Type</th>
                        <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Status</th>
                        <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">HTTP Code</th>
                        <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Timestamp</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {deliveriesData?.deliveries.map((delivery) => (
                        <tr key={delivery.id}>
                          <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm font-medium text-gray-900 sm:pl-0">
                            {delivery.eventType}
                          </td>
                          <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                            <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${
                              delivery.status === 'success' ? 'bg-green-50 text-green-700 ring-green-600/20' : 
                              delivery.status === 'failed' ? 'bg-red-50 text-red-700 ring-red-600/20' : 
                              'bg-yellow-50 text-yellow-700 ring-yellow-600/20'
                            }`}>
                              {delivery.status}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                            {delivery.responseStatus || '-'}
                          </td>
                          <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                            {new Date(delivery.createdAt).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                      {(!deliveriesData?.deliveries || deliveriesData.deliveries.length === 0) && (
                        <tr>
                          <td colSpan={4} className="py-4 text-sm text-gray-500 text-center">No recent deliveries found.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      </div>
      </section>
    </main>
  );
}
