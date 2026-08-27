import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.guard';
import { AdminService } from './admin.service';
import {
  MarketControlDto,
  MarketControlResultDto,
  PriceShockDto,
  PriceShockResultDto,
} from './dto/admin.dto';

@ApiTags('Admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/assets')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Post(':symbol/halt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Halt trading in an asset',
    description:
      'Rejects new orders with MARKET_HALTED until resumed. Resting orders are left in place and ' +
      'may still be cancelled. Unlike the circuit breaker, a halt never clears on its own.',
  })
  @ApiParam({ name: 'symbol', example: 'vSOL' })
  @ApiResponse({ status: 200, type: MarketControlResultDto })
  @ApiResponse({ status: 403, description: 'FORBIDDEN' })
  halt(
    @CurrentUser() user: AuthenticatedUser,
    @Param('symbol') symbol: string,
    @Body() body: MarketControlDto,
  ): Promise<MarketControlResultDto> {
    return this.admin.setStatus(user.id, symbol, 'HALTED', body.reason ?? '');
  }

  @Post(':symbol/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resume trading in a halted asset' })
  @ApiParam({ name: 'symbol', example: 'vSOL' })
  @ApiResponse({ status: 200, type: MarketControlResultDto })
  resume(
    @CurrentUser() user: AuthenticatedUser,
    @Param('symbol') symbol: string,
    @Body() body: MarketControlDto,
  ): Promise<MarketControlResultDto> {
    return this.admin.setStatus(user.id, symbol, 'ACTIVE', body.reason ?? '');
  }

  @Post(':symbol/price')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish an out-of-band mark price',
    description:
      'Simulation control. Prints a price outside the random walk so volatility-driven behaviour ' +
      '— the circuit breaker in particular — can be demonstrated on demand.',
  })
  @ApiParam({ name: 'symbol', example: 'vSOL' })
  @ApiResponse({ status: 200, type: PriceShockResultDto })
  shock(
    @Param('symbol') symbol: string,
    @Body() body: PriceShockDto,
  ): Promise<PriceShockResultDto> {
    return this.admin.shockPrice(symbol, body.price);
  }
}
