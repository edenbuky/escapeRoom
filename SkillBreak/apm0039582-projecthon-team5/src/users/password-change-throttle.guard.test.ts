import { ExecutionContext, HttpException } from '@nestjs/common';
import { PasswordChangeThrottleGuard } from './password-change-throttle.guard';

describe('PasswordChangeThrottleGuard', () => {
  test('limits password changes per authenticated user and reports Retry-After', () => {
    const setHeader = jest.fn();
    const request = { user: { id: '18a04af0-9883-4f82-92e3-f1cdf6a84ca0' } };
    const context = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader }) }),
    } as unknown as ExecutionContext;
    const guard = new PasswordChangeThrottleGuard();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(guard.canActivate(context)).toBe(true);
    }
    try {
      guard.canActivate(context);
      throw new Error('Expected the sixth request to be throttled');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
    }
    expect(setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
  });
});