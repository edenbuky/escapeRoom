import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { Role } from '../../config/config';
import { UserStatus } from '../../database/entities/user.entity';

@ValidatorConstraint({ name: 'unicodePasswordLength', async: false })
class UnicodePasswordLength implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && Array.from(value).length >= 15 && Array.from(value).length <= 128;
  }

  defaultMessage(): string {
    return 'password must contain 15 to 128 Unicode characters';
  }
}

export class SignupDto {
  @ApiProperty({ example: 'player_1', minLength: 3, maxLength: 32 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @Matches(/^[a-z0-9_.-]{3,32}$/)
  username!: string;

  @ApiProperty({ example: 'player@example.com', maxLength: 254 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @Length(1, 254)
  email!: string;

  @ApiProperty({ minLength: 15, maxLength: 128 })
  @IsString()
  @Validate(UnicodePasswordLength)
  password!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'player_1' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @Length(3, 32)
  username!: string;

  @ApiProperty()
  @IsString()
  @Validate(UnicodePasswordLength)
  password!: string;
}

export class UserDto {
  @ApiProperty() id!: string;
  @ApiProperty() username!: string;
  @ApiProperty() email!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ enum: ['player', 'admin'] }) role!: string;
  @ApiProperty() createdAt!: string;
}

export class AccessTokenDto {
  @ApiProperty() accessToken!: string;
  @ApiProperty({ example: 'Bearer' }) tokenType!: string;
  @ApiProperty() expiresIn!: number;
  @ApiProperty() refreshToken!: string;
  @ApiProperty() refreshExpiresAt!: string;
  @ApiProperty({ type: UserDto }) user!: UserDto;
}

export class UpdateMeDto {
  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @Length(1, 64)
  displayName!: string;
}

export class RefreshCredentialDto {
  @ApiProperty({ minLength: 43, maxLength: 43 })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  refreshToken!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ minLength: 15, maxLength: 128 })
  @IsString()
  @Validate(UnicodePasswordLength)
  currentPassword!: string;

  @ApiProperty({ minLength: 15, maxLength: 128 })
  @IsString()
  @Validate(UnicodePasswordLength)
  newPassword!: string;
}

export class AdminCreateUserDto extends SignupDto {
  @ApiProperty({ enum: Role })
  @IsEnum(Role)
  role!: Role;
}

export class ChangeRoleDto {
  @ApiProperty({ enum: Role })
  @IsEnum(Role)
  role!: Role;
}

export class AdminUserDto extends UserDto {
  @ApiProperty({ enum: UserStatus }) status!: UserStatus;
  @ApiProperty({ nullable: true, type: String }) deletedAt!: string | null;
}

export class AdminUserQueryDto {
  @ApiProperty({ required: false, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiProperty({ required: false, default: 20, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;

  @ApiProperty({ required: false, enum: Role })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiProperty({ required: false, enum: UserStatus })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @ApiProperty({ required: false, maxLength: 254 })
  @IsOptional()
  @IsString()
  @Length(1, 254)
  q?: string;
}

export class AdminUsersPageDto {
  @ApiProperty({ type: [AdminUserDto] }) items!: AdminUserDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}