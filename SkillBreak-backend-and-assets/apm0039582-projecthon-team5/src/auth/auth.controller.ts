import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
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