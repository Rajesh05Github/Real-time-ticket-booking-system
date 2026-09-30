'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { Button } from '../../../components/ui/button';
import { Field, Input } from '../../../components/ui/field';
import { useToast } from '../../../components/ui/toast';
import { handleApiError } from '../../../lib/api/handle-error';
import { useAuth } from '../../../lib/auth/auth-context';

export default function LoginPage(): React.JSX.Element {
  const { login } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      await login(email, password);
      const next = searchParams.get('next');
      router.replace(next && next.startsWith('/') ? next : '/');
    } catch (err) {
      handleApiError(err, { toast });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-fg">Welcome back</h1>
        <p className="mt-1 text-sm text-fg-muted">Log in to reserve and buy tickets.</p>
      </div>

      <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button type="submit" className="w-full" isLoading={isSubmitting}>
          Log in
        </Button>
      </form>

      <p className="text-center text-sm text-fg-muted">
        New here?{' '}
        <Link href="/register" className="text-brand-300 hover:text-brand-200">
          Create an account
        </Link>
      </p>
    </div>
  );
}
