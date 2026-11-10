import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiAcceptedResponse, ApiBearerAuth, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsUUID, Matches, Validate, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import type { PuzzleInput } from '@team5/contracts';
import type { Request } from 'express';
import { AuthenticatedActor } from '../auth/auth.service';
import { JwtAuthGuard, RolesGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../config/config';
import { SessionsService } from './sessions.service';

@ValidatorConstraint({ name: 'puzzleInput', async: false })
export class PuzzleInputValidator implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const input = value as Record<string, unknown>;
    const fields = input.kind === 'command' ? ['command'] : input.kind === 'answer' ? ['answer']
      : input.kind === 'credentials' ? ['username', 'password']
        : input.kind === 'rsa' ? ['privateKey', 'encryptedPms', 'modulus']
          : input.kind === 'tls' ? ['pms', 'clientRandom'] : undefined;
    return Boolean(fields && Object.keys(input).length === fields.length + 1
      && fields.every(field => typeof input[field] === 'string' && (input[field] as string).length > 0)
      && Buffer.byteLength(JSON.stringify(input)) <= 8192);
  }
  defaultMessage(): string { return 'input must be a canonical puzzle input of at most 8192 bytes'; }
}

export class StartSessionDto {
  @ApiProperty({ example: 'escape-room', pattern: '^[a-z0-9-]{1,64}$' })
  @Matches(/^[a-z0-9-]{1,64}$/)
  scriptSlug!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  requestId!: string;
}

export class SubmitInputDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  commandId!: string;

  @ApiProperty({ oneOf: [
    { type: 'object', additionalProperties: false, required: ['kind', 'command'], properties: {
      kind: { type: 'string', enum: ['command'] }, command: { type: 'string', minLength: 1 } } },
    { type: 'object', additionalProperties: false, required: ['kind', 'answer'], properties: {
      kind: { type: 'string', enum: ['answer'] }, answer: { type: 'string', minLength: 1 } } },
    { type: 'object', additionalProperties: false, required: ['kind', 'username', 'password'], properties: {
      kind: { type: 'string', enum: ['credentials'] }, username: { type: 'string', minLength: 1 }, password: { type: 'string', minLength: 1 } } },
    { type: 'object', additionalProperties: false, required: ['kind', 'privateKey', 'encryptedPms', 'modulus'], properties: {
      kind: { type: 'string', enum: ['rsa'] }, privateKey: { type: 'string', minLength: 1 },
      encryptedPms: { type: 'string', minLength: 1 }, modulus: { type: 'string', minLength: 1 } } },
    { type: 'object', additionalProperties: false, required: ['kind', 'pms', 'clientRandom'], properties: {
      kind: { type: 'string', enum: ['tls'] }, pms: { type: 'string', minLength: 1 }, clientRandom: { type: 'string', minLength: 1 } } },
  ] })
  @Validate(PuzzleInputValidator)
  input!: PuzzleInput;
}

export class DoorCommandDto {
  @IsUUID()
  commandId!: string;
}

class PuzzleParams {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sid!: string;

  @ApiProperty({ pattern: '^[a-z0-9-]{1,64}$' })
  @Matches(/^[a-z0-9-]{1,64}$/)
  key!: string;
}

interface AuthenticatedRequest extends Request { user: AuthenticatedActor; }

@ApiTags('sessions')
@ApiBearerAuth('access-token')
@ApiResponse({ status: 400, description: 'Invalid request' })
@ApiResponse({ status: 401, description: 'Missing, invalid or revoked access token' })
@ApiResponse({ status: 403, description: 'Not the session owner' })
@ApiResponse({ status: 404, description: 'Unknown session' })
@ApiResponse({ status: 503, description: 'Transport or owner service unavailable' })
@Controller('sessions')
@Roles(Role.PLAYER, Role.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard)
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get('resume')
  resume(@Req() request: AuthenticatedRequest) { return this.sessions.resume(request.user.id); }

  @Post()
  @HttpCode(202)
  @ApiAcceptedResponse({ description: 'Accepted for delivery, not committed gameplay', schema: {
    type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' } }, required: ['sessionId'],
  } })
  start(@Req() request: AuthenticatedRequest, @Body() body: StartSessionDto) {
    return this.sessions.start(request.user.id, body.scriptSlug, body.requestId);
  }

  @Post(':sid/puzzles/:key/inputs')
  @HttpCode(202)
  @ApiAcceptedResponse({ schema: { type: 'object', properties: { commandId: { type: 'string', format: 'uuid' } } } })
  submit(@Req() request: AuthenticatedRequest, @Param() params: PuzzleParams, @Body() body: SubmitInputDto) {
    return this.sessions.submit(request.user.id, params.sid, params.key, body.commandId, body.input);
  }

  @Post(':sid/abandon')
  @HttpCode(202)
  @ApiAcceptedResponse()
  abandon(@Req() request: AuthenticatedRequest, @Param('sid', ParseUUIDPipe) sid: string) {
    return this.sessions.abandon(request.user.id, sid);
  }

  @Post(':sid/rooms/:key/open-door')
  @HttpCode(202)
  openDoor(@Req() request: AuthenticatedRequest, @Param() params: PuzzleParams, @Body() body: DoorCommandDto) {
    return this.sessions.door(request.user.id, params.sid, params.key, body.commandId, 'OpenDoor');
  }

  @Post(':sid/rooms/:key/enter')
  @HttpCode(202)
  enterRoom(@Req() request: AuthenticatedRequest, @Param() params: PuzzleParams, @Body() body: DoorCommandDto) {
    return this.sessions.door(request.user.id, params.sid, params.key, body.commandId, 'EnterRoom');
  }
}