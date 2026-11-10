import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { describeFailure } from '@team5/messaging';
import { TypeORMError } from 'typeorm';
import { Request, Response } from 'express';

@Catch(TypeORMError)
export class DatabaseExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DatabaseExceptionFilter.name);

  catch(exception: TypeORMError, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const route: unknown = request.route?.path;
    this.logger.error(`Database request failed: ${describeFailure(exception)} method=${request.method} route=${typeof route === 'string' ? route : 'unmatched'}`);
    response.status(503).json({ statusCode: 503, message: 'Service unavailable' });
  }
}