import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'trader@example.com' })
  @IsEmail({}, { message: 'email must be a valid email address' })
  email!: string;

  @ApiProperty({ example: 'Password123!', minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  @MaxLength(128)
  password!: string;

  @ApiProperty({ example: 'Ada Lovelace', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string;
}

export class LoginDto {
  @ApiProperty({ example: 'alice@example.com' })
  @IsEmail({}, { message: 'email must be a valid email address' })
  email!: string;

  @ApiProperty({ example: 'Password123!' })
  @IsString()
  @MinLength(1)
  password!: string;
}

export class AuthUserDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ enum: ['USER', 'ADMIN'] }) role!: 'USER' | 'ADMIN';
}

export class AuthTokenDto {
  @ApiProperty({ description: 'Bearer token. Send as `Authorization: Bearer <token>`.' })
  accessToken!: string;

  @ApiProperty({ example: '12h' })
  expiresIn!: string;

  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;
}
