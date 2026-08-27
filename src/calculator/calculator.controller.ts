import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { CalculatorService } from './calculator.service';
import { CalculatorRequestDto, CalculatorResponseDto } from './dto/calculator.dto';

@ApiTags('Calculator')
@Controller('calculator')
export class CalculatorController {
  constructor(private readonly calculator: CalculatorService) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview an order without placing it',
    description:
      'Converts a USD amount into shares (or a share quantity into USD) by walking the same ' +
      'book the matching engine walks. Reserves nothing and writes nothing.',
  })
  @ApiResponse({ status: 200, type: CalculatorResponseDto })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 404, description: 'ASSET_NOT_FOUND' })
  quote(@Body() body: CalculatorRequestDto): Promise<CalculatorResponseDto> {
    return this.calculator.quote(body);
  }
}
