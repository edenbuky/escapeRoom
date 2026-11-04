import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { Role } from '../config/config';
import { AuthenticatedActor } from '../auth/auth.service';
import {
  AdminCreateUserDto,
  AdminUserDto,
  AdminUserQueryDto,
  AdminUsersPageDto,
  ChangeRoleDto,
} from '../auth/dto/auth.dto';
import { JwtAuthGuard, RolesGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { AdminUsersService } from './admin-users.service';

interface AdminRequest extends Request {
  user: AuthenticatedActor;
}

@ApiTags('admin users')
@ApiBearerAuth('access-token')
@Controller('admin/users')
@Roles(Role.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminUsersController {
  constructor(private readonly adminUsers: AdminUsersService) {}

  @Get()
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Positive page number', example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: 'Page size from 1 to 100', example: 20 })
  @ApiOkResponse({ type: AdminUsersPageDto })
  list(@Query() query: AdminUserQueryDto): Promise<AdminUsersPageDto> {
    return this.adminUsers.list(query);
  }

  @Get(':id')
  @ApiOkResponse({ type: AdminUserDto })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AdminUserDto> {
    return this.adminUsers.get(id);
  }

  @Post()
  @ApiCreatedResponse({ type: AdminUserDto })
  create(@Req() request: AdminRequest, @Body() input: AdminCreateUserDto): Promise<AdminUserDto> {
    return this.adminUsers.create(request.user, input);
  }

  @Patch(':id/role')
  @ApiOkResponse({ type: AdminUserDto })
  changeRole(
    @Req() request: AdminRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: ChangeRoleDto,
  ): Promise<AdminUserDto> {
    return this.adminUsers.changeRole(request.user, id, input);
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AdminUserDto })
  disable(@Req() request: AdminRequest, @Param('id', ParseUUIDPipe) id: string): Promise<AdminUserDto> {
    return this.adminUsers.disable(request.user, id);
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AdminUserDto })
  enable(@Req() request: AdminRequest, @Param('id', ParseUUIDPipe) id: string): Promise<AdminUserDto> {
    return this.adminUsers.enable(request.user, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(@Req() request: AdminRequest, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.adminUsers.remove(request.user, id);
  }
}