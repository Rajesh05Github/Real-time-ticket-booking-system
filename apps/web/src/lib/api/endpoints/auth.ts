import { apiFetch } from '../client';

import type { LoginUser, MeUser } from '../types';

export function register(email: string, password: string): Promise<{ data: unknown }> {
  return apiFetch('/auth/register', { method: 'POST', body: { email, password } });
}

export function resendOtp(email: string): Promise<{ data: { sent: boolean } }> {
  return apiFetch('/auth/resend-otp', { method: 'POST', body: { email } });
}

export function verifyOtp(email: string, otp: string): Promise<{ data: { verified: boolean } }> {
  return apiFetch('/auth/verify-otp', { method: 'POST', body: { email, otp } });
}

export async function login(email: string, password: string): Promise<LoginUser> {
  const { data } = await apiFetch<{ user: LoginUser }>('/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  return data.user;
}

export function logout(): Promise<{ data: { loggedOut: boolean } }> {
  return apiFetch('/auth/logout', { method: 'POST' });
}

export async function me(): Promise<MeUser> {
  const { data } = await apiFetch<MeUser>('/me');
  return data;
}
