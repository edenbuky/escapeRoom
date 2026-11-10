import {
  ArgumentsHost, BadRequestException, CanActivate, Catch, Controller, ExceptionFilter,
  ExecutionContext, Get, Header, HttpException, Inject, Injectable, Logger, NotFoundException,
  Param, ParseIntPipe, ServiceUnavailableException, UnauthorizedException, UseFilters, UseGuards,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import type { Response } from 'express';
import { describeFailure } from '@team5/messaging';
import { ENGINE_CONFIG, type EngineConfig } from '../../config/config';
import { INTERNAL_TOKEN_HEADER, matchesInternalToken } from '../../config/internal-token';
import { CatalogRepository } from './catalog.repository';

@Injectable()
export class CatalogTokenGuard implements CanActivate {
  constructor(@Inject(ENGINE_CONFIG) private readonly config: EngineConfig) {}
  canActivate(context: ExecutionContext): boolean {
    if (!this.config.internalApiToken) throw new ServiceUnavailableException();
    const request = context.switchToHttp().getRequest<IncomingMessage>();
    if (!matchesInternalToken(request.headers[INTERNAL_TOKEN_HEADER], this.config.internalApiToken)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}

@Catch()
export class CatalogErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(CatalogErrorFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const code = error instanceof HttpException ? error.getStatus() : 503;
    if (!(error instanceof HttpException)) this.logger.warn(`Catalog request failed: ${describeFailure(error)}`);
    host.switchToHttp().getResponse<Response>().setHeader('Cache-Control', 'no-store')
      .status(code).json({ statusCode: code });
  }
}

@Controller('internal')
@UseGuards(CatalogTokenGuard)
@UseFilters(CatalogErrorFilter)
export class CatalogController {
  constructor(private readonly repository: CatalogRepository) {}

  private version(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new BadRequestException();
    return value;
  }

  @Get('scripts/by-slug/:slug/current')
  @Header('Cache-Control', 'no-store')
  async current(@Param('slug') slug: string) {
    const result = await this.repository.current(slug);
    if (!result) throw new NotFoundException();
    return result;
  }

  @Get('scripts/:id/versions/:version')
  @Header('Cache-Control', 'no-store')
  async script(@Param('id') id: string, @Param('version', ParseIntPipe) version: number) {
    const result = await this.repository.script(id, this.version(version));
    if (!result) throw new NotFoundException();
    return result;
  }

  @Get('templates/:key/versions/:version')
  @Header('Cache-Control', 'no-store')
  async template(@Param('key') key: string, @Param('version', ParseIntPipe) version: number) {
    const result = await this.repository.template(key, this.version(version));
    if (!result) throw new NotFoundException();
    return result;
  }
}