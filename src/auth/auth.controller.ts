import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from './current-user.decorator';
import { AuthenticatedUser } from './auth.types';
import { AuthService } from './auth.service';
import { AuthTokenDto, AuthUserDto, LoginDto, RegisterDto } from './dto/auth.dto';
import { Public } from './public.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an account',
    description: 'Registers a trader and credits the configured welcome stablecoin balance.',
  })
  @ApiResponse({ status: 201, type: AuthTokenDto })
  @ApiResponse({ status: 409, description: 'EMAIL_ALREADY_REGISTERED' })
  register(@Body() dto: RegisterDto): Promise<AuthTokenDto> {
    return this.auth.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange credentials for a bearer token' })
  @ApiResponse({ status: 200, type: AuthTokenDto })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  login(@Body() dto: LoginDto): Promise<AuthTokenDto> {
    return this.auth.login(dto);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return the authenticated principal' })
  @ApiResponse({ status: 200, type: AuthUserDto })
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }
}
