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
