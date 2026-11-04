import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserStatus } from '../database/entities/user.entity';
import { UpdateMeDto, UserDto } from '../auth/dto/auth.dto';
import { AuthenticatedActor, AuthService } from '../auth/auth.service';
import { ChangePasswordDto } from '../auth/dto/auth.dto';

function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly auth: AuthService,
  ) {}

  async getMe(id: string): Promise<UserDto> {
    const user = await this.users.findOneBy({ id, status: UserStatus.ACTIVE });
    if (!user) throw new NotFoundException();
    return toUserDto(user);
  }

  async updateMe(actor: AuthenticatedActor, input: UpdateMeDto): Promise<UserDto> {
    return this.users.manager.transaction(async (manager) => {
      const { user } = await this.auth.lockCurrentActor(manager, actor);
      user.displayName = input.displayName;
      return toUserDto(await manager.getRepository(User).save(user));
    });
  }

  changePassword(actor: AuthenticatedActor, input: ChangePasswordDto): Promise<void> {
    return this.auth.changePassword(actor, input);
  }
}