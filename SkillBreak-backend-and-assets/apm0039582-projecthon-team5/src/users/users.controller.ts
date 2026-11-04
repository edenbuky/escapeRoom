import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Role } from '../config/config';
import { JwtAuthGuard, RolesGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { AuthenticatedActor } from '../auth/auth.service';
import { ChangePasswordDto, UpdateMeDto, UserDto } from '../auth/dto/auth.dto';
import { UsersService } from './users.service';
import { PasswordChangeThrottleGuard } from './password-change-throttle.guard';

interface AuthenticatedRequest extends Request {
  user: AuthenticatedActor;
}

@ApiTags('users')
@ApiBearerAuth('access-token')
@Controller('me')
@Roles(Role.PLAYER, Role.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOkResponse({ type: UserDto })
  getMe(@Req() request: AuthenticatedRequest): Promise<UserDto> {
    return this.users.getMe(request.user.id);
  }

  @Patch()
  @ApiOkResponse({ type: UserDto })
  updateMe(@Req() request: AuthenticatedRequest, @Body() input: UpdateMeDto): Promise<UserDto> {
    return this.users.updateMe(request.user, input);
  }

  @Patch('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PasswordChangeThrottleGuard)
  changePassword(
    @Req() request: AuthenticatedRequest,
    @Body() input: ChangePasswordDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    return this.users.changePassword(request.user, input);
  }
}