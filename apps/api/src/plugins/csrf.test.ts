import { createHmac } from 'node:crypto';

import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@flashsale/shared';
import { describe, expect, it } from 'vitest';

import { verifyCsrf } from './csrf.js';

// env.COOKIE_SECRET during tests, set by vitest.config.ts's `test.env`.
const COOKIE_SECRET = 'test-cookie-secret-at-least-32-characters-long';

function tokenFor(sessionId: string): string {
  return createHmac('sha256', COOKIE_SECRET).update(sessionId).digest('hex');
}

function fakeRequest(method: string, headers: Record<string, string> = {}, cookies: Record<string, string> = {}) {
  return { method, headers, cookies } as never;
}

describe('verifyCsrf', () => {
  it('does nothing for safe methods (GET/HEAD/OPTIONS), even with no token at all', () => {
    expect(() => verifyCsrf(fakeRequest('GET'), 'session-1')).not.toThrow();
    expect(() => verifyCsrf(fakeRequest('HEAD'), 'session-1')).not.toThrow();
    expect(() => verifyCsrf(fakeRequest('OPTIONS'), 'session-1')).not.toThrow();
  });

  it('rejects a mutating request with no CSRF header or cookie at all', () => {
    expect(() => verifyCsrf(fakeRequest('POST'), 'session-1')).toThrow('Missing CSRF token.');
  });

  it('rejects a mutating request with the cookie but no header', () => {
    const request = fakeRequest('POST', {}, { [CSRF_COOKIE_NAME]: tokenFor('session-1') });
    expect(() => verifyCsrf(request, 'session-1')).toThrow('Missing CSRF token.');
  });

  it('rejects when the header and cookie disagree with each other', () => {
    const request = fakeRequest(
      'POST',
      { [CSRF_HEADER_NAME]: 'a'.repeat(64) },
      { [CSRF_COOKIE_NAME]: tokenFor('session-1') },
    );
    expect(() => verifyCsrf(request, 'session-1')).toThrow('Invalid or stale CSRF token.');
  });

  it("rejects a header+cookie pair that agree with EACH OTHER but not with this session's real token (a forged/stale pair)", () => {
    const forged = 'b'.repeat(64);
    const request = fakeRequest('POST', { [CSRF_HEADER_NAME]: forged }, { [CSRF_COOKIE_NAME]: forged });
    expect(() => verifyCsrf(request, 'session-1')).toThrow('Invalid or stale CSRF token.');
  });

  it('accepts a matching, correctly-derived token for the given session on a mutating request', () => {
    const token = tokenFor('session-1');
    const request = fakeRequest('POST', { [CSRF_HEADER_NAME]: token }, { [CSRF_COOKIE_NAME]: token });
    expect(() => verifyCsrf(request, 'session-1')).not.toThrow();
  });

  it("rejects a valid token that belongs to a DIFFERENT session (can't be replayed across sessions)", () => {
    const tokenForOtherSession = tokenFor('some-other-session');
    const request = fakeRequest(
      'POST',
      { [CSRF_HEADER_NAME]: tokenForOtherSession },
      { [CSRF_COOKIE_NAME]: tokenForOtherSession },
    );
    expect(() => verifyCsrf(request, 'session-1')).toThrow('Invalid or stale CSRF token.');
  });
});
