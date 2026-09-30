'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '../../../components/ui/button';
import { Field, Input } from '../../../components/ui/field';
import { useToast } from '../../../components/ui/toast';
import { register } from '../../../lib/api/endpoints/auth';
import { handleApiError } from '../../../lib/api/handle-error';

const MIN_PASSWORD_LENGTH = 8;

export default function RegisterPage(): React.JSX.Element {
  const router = useRouter();
  const { toast } = useToast();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      await register(email, password);
      router.push(`/verify?email=${encodeURIComponent(email)}`);
    } catch (err) {
      handleApiError(err, { toast });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-fg">Create your account</h1>
        <p className="mt-1 text-sm text-fg-muted">We&apos;ll send a verification code to your email.</p>
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
        <Field label="Password" htmlFor="password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button type="submit" className="w-full" isLoading={isSubmitting}>
          Sign up
        </Button>
      </form>

      <p className="text-center text-sm text-fg-muted">
        Already have an account?{' '}
        <Link href="/login" className="text-brand-300 hover:text-brand-200">
          Log in
        </Link>
      </p>
    </div>
  );
}
