import { logAuthMessage } from '@/auth/logging';
import { expect, test, vi } from 'vitest';

test('auth logger keeps error classes but never logs bound values', () => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    logAuthMessage(
      'error',
      'INTERNAL_SERVER_ERROR',
      new Error('query params: sensitive-value'),
    );

    expect(errorLog).toHaveBeenCalledOnce();
    const line = errorLog.mock.calls[0][0] as string;
    expect(JSON.parse(line)).toEqual({
      errorClass: 'Error',
      event: 'auth.library',
      level: 'error',
    });
    expect(line).not.toContain('sensitive-value');
  } finally {
    errorLog.mockRestore();
  }
});

test('auth logger preserves a safe code for weak-secret warnings', () => {
  const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    logAuthMessage(
      'warn',
      '[better-auth] Warning: your BETTER_AUTH_SECRET appears low-entropy. Use a randomly generated secret for production.',
    );

    expect(warningLog).toHaveBeenCalledOnce();
    expect(JSON.parse(warningLog.mock.calls[0][0] as string)).toEqual({
      diagnosticCode: 'low_entropy_auth_secret',
      event: 'auth.library',
      level: 'warn',
    });
  } finally {
    warningLog.mockRestore();
  }
});
