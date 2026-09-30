'use client';

import { OTP_LENGTH, OTP_RESEND_COOLDOWN_SECONDS } from '@flashsale/shared';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Button } from '../../../components/ui/button';
import { useToast } from '../../../components/ui/toast';
import { resendOtp, verifyOtp } from '../../../lib/api/endpoints/auth';
import { handleApiError } from '../../../lib/api/handle-error';

export default function VerifyPage(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const email = searchParams.get('email') ?? '';

  const [digits, setDigits] = useState<string[]>(Array(OTP_LENGTH).fill(''));
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  function setDigit(index: number, value: string): void {
    if (!/^\d?$/.test(value)) return;
    setDigits((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
    if (value && index < OTP_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  }

  function onKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLInputElement>): void {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH);
    if (!pasted) return;
    e.preventDefault();
    setDigits(Array.from({ length: OTP_LENGTH }, (_, i) => pasted[i] ?? ''));
    inputRefs.current[Math.min(pasted.length, OTP_LENGTH - 1)]?.focus();
  }

  async function onVerify(): Promise<void> {
    const code = digits.join('');
    if (code.length !== OTP_LENGTH) return;
    setIsVerifying(true);
    try {
      await verifyOtp(email, code);
      toast({ kind: 'success', title: 'Email verified', description: 'You can now log in.' });
      router.push('/login?verified=1');
    } catch (err) {
      handleApiError(err, { toast });
    } finally {
      setIsVerifying(false);
    }
  }

  async function onResend(): Promise<void> {
    setIsResending(true);
    try {
      await resendOtp(email);
      toast({ kind: 'success', title: 'Code sent', description: `We sent a new code to ${email}.` });
      setCooldown(OTP_RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      handleApiError(err, { toast });
    } finally {
      setIsResending(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-fg">Verify your email</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Enter the {OTP_LENGTH}-digit code we sent to <span className="text-fg">{email || 'your email'}</span>.
        </p>
      </div>

      <div className="flex justify-center gap-2">
        {digits.map((digit, i) => (
          <input
            key={i}
            ref={(el) => {
              inputRefs.current[i] = el;
            }}
            type="text"
            inputMode="numeric"
            maxLength={1}
            value={digit}
            onChange={(e) => setDigit(i, e.target.value)}
            onKeyDown={(e) => onKeyDown(i, e)}
            onPaste={onPaste}
            className="h-12 w-10 rounded-md border border-border bg-surface-2 text-center font-mono text-lg text-fg outline-none focus:border-brand-400"
          />
        ))}
      </div>

      <Button
        className="w-full"
        isLoading={isVerifying}
        disabled={digits.join('').length !== OTP_LENGTH}
        onClick={() => void onVerify()}
      >
        Verify
      </Button>

      <div className="text-center text-sm text-fg-muted">
        Didn&apos;t get a code?{' '}
        <button
          type="button"
          onClick={() => void onResend()}
          disabled={cooldown > 0 || isResending}
          className="text-brand-300 hover:text-brand-200 disabled:text-fg-subtle"
        >
          {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend'}
        </button>
      </div>
    </div>
  );
}
