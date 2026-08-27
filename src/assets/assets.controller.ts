import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { CircuitBreakerService } from './circuit-breaker.service';
import { MarketDataService } from './market-data.service';
import {
  AssetDetailDto,
  AssetDto,
  OrderBookDto,
  OrderBookQueryDto,
  PriceHistoryDto,
  PriceHistoryQueryDto,
} from './dto/asset.dto';
import { toAssetDto, toOrderBookDto, toPriceHistoryDto } from './assets.mapper';

const DEFAULT_HISTORY_LIMIT = 200;
const DEFAULT_BOOK_DEPTH = 10;

/**
 * Market data is public: quotes are not privileged information, and leaving the
 * read side open keeps the trading console and any downstream chart trivially
 * embeddable. Everything that moves money sits behind the bearer guard.
 */
@ApiTags('Market Data')
@Controller('assets')
export class AssetsController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly breakers: CircuitBreakerService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'List the tradable universe',
    description: 'Returns every listed asset with its live mark, top of book and breaker state.',
  })
  @ApiResponse({ status: 200, type: [AssetDto] })
  async list(): Promise<AssetDto[]> {
    const assets = this.marketData.list();
    return Promise.all(
      assets.map(async (asset) => {
        const [book, stats] = await Promise.all([
          this.marketData.getBookSnapshot(asset.symbol),
          this.marketData.getStats(asset.symbol),
        ]);
        // Price comes from the snapshot, not a fresh read: a tick landing
        // between the two would otherwise print a top of book that straddles
        // the quoted mark.
        return toAssetDto({
          asset,
          price: book.mid,
          book,
          breaker: this.breakers.getState(asset.symbol),
          stats,
        });
      }),
    );
  }

  @Public()
  @Get(':symbol')
  @ApiOperation({ summary: 'Fetch one asset with its current order book' })
  @ApiParam({ name: 'symbol', example: 'vSOL' })
  @ApiResponse({ status: 200, type: AssetDetailDto })
  @ApiResponse({ status: 404, description: 'ASSET_NOT_FOUND' })
  async detail(@Param('symbol') symbol: string): Promise<AssetDetailDto> {
    const asset = this.marketData.requireAsset(symbol);
    const [book, stats] = await Promise.all([
      this.marketData.getBookSnapshot(asset.symbol),
      this.marketData.getStats(asset.symbol),
    ]);
    return {
      ...toAssetDto({
        asset,
        price: book.mid,
        book,
        breaker: this.breakers.getState(asset.symbol),
        stats,
      }),
      book: toOrderBookDto(book, DEFAULT_BOOK_DEPTH),
    };
  }

  @Public()
  @Get(':symbol/history')
  @ApiOperation({
    summary: 'Price history for an asset',
    description:
      'Returns simulated ticks oldest-first. Bound the range with `from`/`to`; `limit` selects ' +
      'the most recent N points inside that range.',
  })
  @ApiParam({ name: 'symbol', example: 'vSOL' })
  @ApiResponse({ status: 200, type: PriceHistoryDto })
  async history(
    @Param('symbol') symbol: string,
    @Query() query: PriceHistoryQueryDto,
  ): Promise<PriceHistoryDto> {
    const asset = this.marketData.requireAsset(symbol);
    const points = await this.marketData.getHistory(asset.symbol, {
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      limit: query.limit ?? DEFAULT_HISTORY_LIMIT,
    });
    return toPriceHistoryDto(asset.symbol, points);
  }

  @Public()
  @Get(':symbol/book')
  @ApiOperation({
    summary: 'Aggregated order book',
    description: 'Resting user limit orders merged with synthetic market-maker depth.',
  })
  @ApiParam({ name: 'symbol', example: 'vSOL' })
  @ApiResponse({ status: 200, type: OrderBookDto })
  async book(
    @Param('symbol') symbol: string,
    @Query() query: OrderBookQueryDto,
  ): Promise<OrderBookDto> {
    const asset = this.marketData.requireAsset(symbol);
    const snapshot = await this.marketData.getBookSnapshot(asset.symbol);
    return toOrderBookDto(snapshot, query.depth ?? DEFAULT_BOOK_DEPTH);
  }
}
