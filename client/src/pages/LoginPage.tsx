import { FormEvent, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Navigate, useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { loginMerchant, registerMerchant } from '../api/auth';
import { useAuth } from '../providers/AuthProvider';

type AuthMode = 'login' | 'register';

export function LoginPage() {
  const navigate = useNavigate();
  const { setSession, tokens } = useAuth();
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [merchantName, setMerchantName] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      mode === 'login'
        ? loginMerchant({ email, password })
        : registerMerchant({ email, password, merchantName }),
    onSuccess(session) {
      setSession(session);
      navigate('/dashboard');
    }
  });

  if (tokens?.accessToken) {
    return <Navigate to="/dashboard" replace />;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <main className="min-h-screen bg-surface">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl items-center px-6 py-10">
        <section className="grid w-full gap-8 lg:grid-cols-[1fr_420px] lg:items-center">
          <div>
            <div className="mb-8 inline-flex h-12 w-12 items-center justify-center rounded-md bg-ink text-white">
              <ShieldCheck size={24} aria-hidden="true" />
            </div>
            <h1 className="max-w-2xl text-4xl font-semibold tracking-normal text-ink">
              PayBridge Merchant Portal
            </h1>
            <p className="mt-4 max-w-xl text-base leading-7 text-slate-600">
              Manage simulated checkout integrations, payment states, webhook delivery, and diagnostics from one protected merchant workspace.
            </p>
          </div>

          <div className="rounded-md border border-line bg-white p-6 shadow-sm">
            <div className="mb-6 grid grid-cols-2 rounded-md border border-line p-1">
              <button
                type="button"
                className={`rounded px-3 py-2 text-sm font-medium ${mode === 'login' ? 'bg-ink text-white' : 'text-slate-600'}`}
                onClick={() => setMode('login')}
              >
                Login
              </button>
              <button
                type="button"
                className={`rounded px-3 py-2 text-sm font-medium ${mode === 'register' ? 'bg-ink text-white' : 'text-slate-600'}`}
                onClick={() => setMode('register')}
              >
                Register
              </button>
            </div>

            <form className="space-y-4" onSubmit={submit}>
              {mode === 'register' ? (
                <label className="block">
                  <span className="text-sm font-medium text-slate-700">Merchant name</span>
                  <input
                    className="mt-1 w-full rounded-md border border-line px-3 py-2 outline-none focus:border-ink"
                    value={merchantName}
                    onChange={(event) => setMerchantName(event.target.value)}
                    required
                    minLength={2}
                  />
                </label>
              ) : null}

              <label className="block">
                <span className="text-sm font-medium text-slate-700">Email</span>
                <input
                  className="mt-1 w-full rounded-md border border-line px-3 py-2 outline-none focus:border-ink"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium text-slate-700">Password</span>
                <input
                  className="mt-1 w-full rounded-md border border-line px-3 py-2 outline-none focus:border-ink"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={mode === 'register' ? 8 : 1}
                />
              </label>

              {mutation.isError ? (
                <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  Authentication failed. Check your credentials and try again.
                </p>
              ) : null}

              <button
                className="w-full rounded-md bg-ink px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
                type="submit"
                disabled={mutation.isPending}
              >
                {mutation.isPending ? 'Submitting...' : mode === 'login' ? 'Login' : 'Create account'}
              </button>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}
