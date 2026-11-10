import { ArgumentsHost, Logger } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { DatabaseExceptionFilter } from './database-exception.filter';

test('logs the error name, code, method and route, and keeps the 503 body', () => {
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const json = jest.fn();
  const response = { status: jest.fn(() => ({ json })) };
  const request = { method: 'POST', route: { path: '/api/team5/auth/register' }, url: '/api/team5/auth/register?u=danaZ22' };
  const host = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) } as unknown as ArgumentsHost;
  const driverError = Object.assign(new Error('duplicate key danaZ22'), { code: '23505', constraint: 'users_username_key' });

  new DatabaseExceptionFilter().catch(new QueryFailedError("INSERT 'danaZ22'", ['danaZ22'], driverError), host);

  expect(response.status).toHaveBeenCalledWith(503);
  expect(json).toHaveBeenCalledWith({ statusCode: 503, message: 'Service unavailable' });
  expect(error).toHaveBeenCalledWith(
    'Database request failed: QueryFailedError code=23505 constraint=users_username_key method=POST route=/api/team5/auth/register');
  expect(JSON.stringify(error.mock.calls)).not.toContain('danaZ22');
  error.mockRestore();
});
