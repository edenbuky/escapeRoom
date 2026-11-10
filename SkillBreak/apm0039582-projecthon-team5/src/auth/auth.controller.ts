import { Body, Controller, ForbiddenException, HttpCode, HttpStatus, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { Role } from '../config/config';
import { AuthenticatedActor, AuthService } from './auth.service';
import { AccessTokenDto, LoginDto, RefreshCredentialDto, SignupDto, UserDto } from './dto/auth.dto';
import { JwtAuthGuard, RolesGuard } from './jwt-auth.guard';
import { Roles } from './roles.decorator';

interface AuthenticatedRequest extends Request {
  user: AuthenticatedActor;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private browserRequest(request: Request): void {
    if (request.get('x-skillbreak-browser') !== '1') throw new ForbiddenException();
  }

  private browserToken(request: Request): string {
    this.browserRequest(request);
    const token = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('t5-refresh='))?.slice(11);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new UnauthorizedException();
    return token;
  }

  private browserResponse(tokens: AccessTokenDto, request: Request, response: Response): AccessTokenDto {
    response.setHeader('Cache-Control', 'no-store');
    response.cookie('t5-refresh', tokens.refreshToken, { httpOnly: true, sameSite: 'strict', path: '/',
      secure: process.env.NODE_ENV === 'production' || request.secure, expires: new Date(tokens.refreshExpiresAt) });
    return { ...tokens, refreshToken: '' };
  }

  @Post('browser/login')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async browserLogin(@Body() input: LoginDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    this.browserRequest(request);
    return this.browserResponse(await this.auth.login(input), request, response);
  }

  @Post('browser/refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async browserRefresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.browserResponse(await this.auth.refresh({ refreshToken: this.browserToken(request) }), request, response);
  }

  @Post('browser/logout')
  @HttpCode(204)
  async browserLogout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    this.browserRequest(request);
    let token: string | undefined;
    try { token = this.browserToken(request); } catch (error) { if (!(error instanceof UnauthorizedException)) throw error; }
    if (token) await this.auth.logout({ refreshToken: token });
    response.clearCookie('t5-refresh', { httpOnly: true, sameSite: 'strict', path: '/',
      secure: process.env.NODE_ENV === 'production' || request.secure });
    response.setHeader('Cache-Control', 'no-store');
  }

  @Post('signup')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create a player account' })
  @ApiCreatedResponse({ type: UserDto })
  async signup(@Body() input: SignupDto, @Res({ passthrough: true }) response: Response): Promise<UserDto> {
    response.setHeader('Cache-Control', 'no-store');
    return this.auth.signup(input);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Sign in and receive an access token' })
  @ApiOkResponse({ type: AccessTokenDto })
  async login(@Body() input: LoginDto, @Res({ passthrough: true }) response: Response): Promise<AccessTokenDto> {
    response.setHeader('Cache-Control', 'no-store');
    return this.auth.login(input);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOkResponse({ type: AccessTokenDto })
  async refresh(@Body() input: RefreshCredentialDto, @Res({ passthrough: true }) response: Response): Promise<AccessTokenDto> {
    response.setHeader('Cache-Control', 'no-store');
    return this.auth.refresh(input);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiNoContentResponse()
  async logout(@Body() input: RefreshCredentialDto, @Res({ passthrough: true }) response: Response): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    return this.auth.logout(input);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiNoContentResponse()
  @Roles(Role.PLAYER, Role.ADMIN)
  @UseGuards(JwtAuthGuard, RolesGuard)
  async logoutAll(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    return this.auth.logoutAll(request.user);
  }
}