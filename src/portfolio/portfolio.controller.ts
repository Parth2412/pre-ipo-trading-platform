import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { PortfolioService } from './portfolio.service';
import {
  EquityCurveDto,
  LedgerEntryDto,
  LedgerQueryDto,
  PortfolioDto,
  PortfolioHistoryQueryDto,
  PortfolioQueryDto,
  PortfolioTimelineQueryDto,
} from './dto/portfolio.dto';

@ApiTags('Portfolio')
@ApiBearerAuth()
@Controller('portfolio')
export class PortfolioController {
  constructor(private readonly portfolio: PortfolioService) {}

  @Get()
  @ApiOperation({
    summary: 'Current portfolio',
    description:
      'Holdings with weighted-average cost basis, mark-to-market value, and realised and ' +
      'unrealised P&L, plus cash and account-level totals.',
  })
  @ApiResponse({ status: 200, type: PortfolioDto })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PortfolioQueryDto,
  ): Promise<PortfolioDto> {
    return this.portfolio.getPortfolio(user.id, { verify: query.verify });
  }

  @Get('history')
  @ApiOperation({
    summary: 'Reconstruct the portfolio at a past instant',
    description:
      'Rebuilds holdings, cost basis and P&L exactly as they stood at `at`, valued at the prices ' +
      'that were actually printed then. Reads the running balance carried on the newest ledger ' +
      'entry and the position snapshot carried on the newest fill at or before that instant, so ' +
      'the cost is three index seeks rather than a replay of the account history. Pass ' +
      '`verify=true` to also recompute the whole thing from raw ledger deltas and report any drift.',
  })
  @ApiResponse({ status: 200, type: PortfolioDto })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_FAILED — `at` missing, malformed or in the future',
  })
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PortfolioHistoryQueryDto,
  ): Promise<PortfolioDto> {
    return this.portfolio.getPortfolio(user.id, { at: new Date(query.at), verify: query.verify });
  }

  @Get('timeline')
  @ApiOperation({
    summary: 'Equity curve',
    description:
      'Point-in-time reconstruction sampled across a window. Affordable only because each point ' +
      'is an index seek rather than a history replay.',
  })
  @ApiResponse({ status: 200, type: EquityCurveDto })
  timeline(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PortfolioTimelineQueryDto,
  ): Promise<EquityCurveDto> {
    return this.portfolio.getEquityCurve(user.id, {
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      points: query.points,
    });
  }

  @Get('ledger')
  @ApiOperation({
    summary: 'Account statement',
    description: 'The raw double-entry ledger behind every balance, newest first.',
  })
  @ApiResponse({ status: 200, type: [LedgerEntryDto] })
  ledger(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: LedgerQueryDto,
  ): Promise<LedgerEntryDto[]> {
    return this.portfolio.getLedger(user.id, {
      limit: query.limit ?? 100,
      offset: query.offset ?? 0,
    });
  }
}
