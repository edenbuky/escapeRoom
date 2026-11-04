import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';

@Injectable()
export class PasswordChangeThrottleGuard implements CanActivate {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const userId = request.user?.id as string | undefined;
    if (!userId) return false;

    const now = Date.now();
    const current = this.attempts.get(userId);
    const bucket = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + 60_000 }
      : current;
    if (bucket.count >= 5) {
      response.setHeader('Retry-After', Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)));
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    bucket.count += 1;
    this.attempts.set(userId, bucket);
    if (this.attempts.size > 10_000) {
      for (const [id, attempt] of this.attempts) {
        if (attempt.resetAt <= now) this.attempts.delete(id);
      }
      while (this.attempts.size > 10_000) {
        const oldestId = this.attempts.keys().next().value as string | undefined;
        if (!oldestId) break;
        this.attempts.delete(oldestId);
      }
    }
    return true;
  }
}