import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class MarketControlDto {
  @ApiPropertyOptional({
    example: 'Pending corporate announcement',
    description: 'Recorded on the audit trail.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  reason?: string;
}

export class PriceShockDto {
  @ApiProperty({
    example: '520.00',
    description: 'New mark price. Snapped to the asset tick size.',
  })
  @Matches(/^\d+(\.\d+)?$/, { message: 'price must be a positive decimal string' })
  price!: string;
}

export class MarketControlResultDto {
  @ApiProperty({ example: 'vSOL' }) symbol!: string;
  @ApiProperty({ enum: ['ACTIVE', 'HALTED'] }) status!: 'ACTIVE' | 'HALTED';
  @ApiProperty({ example: 'Pending corporate announcement' }) reason!: string;
  @ApiProperty() at!: string;
}

export class PriceShockResultDto {
  @ApiProperty({ example: 'vSOL' }) symbol!: string;
  @ApiProperty({ example: '431.450000' }) previousPrice!: string;
  @ApiProperty({ example: '520.000000' }) price!: string;
  @ApiProperty({ example: 2053, description: 'Move applied, in basis points.' }) moveBps!: number;
  @ApiProperty({ description: 'True if this print tripped the circuit breaker.' })
  circuitBreakerTripped!: boolean;
  @ApiProperty() at!: string;
}
