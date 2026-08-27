import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Subscription } from 'rxjs';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { formatPrice, formatQuantity } from '../common/money';
import { AuthService } from '../auth/auth.service';
import { CircuitBreakerService } from '../assets/circuit-breaker.service';
import { MarketDataService } from '../assets/market-data.service';
import { PriceEngineService } from '../assets/price-engine.service';
import { TradingEventsService } from './trading-events.service';

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_CHANNELS_PER_CLIENT = 32;

interface Client {
  readonly socket: WebSocket;
  readonly channels: Set<string>;
  userId?: string;
  alive: boolean;
}

/**
 * WebSocket market data and account stream, served at `/stream`.
 *
 * A raw `ws` server attached to the Nest HTTP server rather than a Nest gateway:
 * the protocol here is a handful of message shapes, and owning it directly keeps
 * the browser console trivial to write and the framing obvious to a reader.
 *
 * Channels
 *   `prices`        every price tick for every asset
 *   `book:<SYMBOL>` top-of-book after each tick on that asset
 *   `orders`        the authenticated user's own order and fill events
 *
 * `orders` requires a bearer token in the subscribe frame. Market data does not,
 * matching the REST surface where quotes are public and accounts are not.
 */
@Injectable()
export class MarketStreamGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MarketStreamGateway.name);
  private readonly clients = new Map<WebSocket, Client>();
  private server?: WebSocketServer;
  private heartbeat?: NodeJS.Timeout;
  private readonly subscriptions: Subscription[] = [];

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly priceEngine: PriceEngineService,
    private readonly marketData: MarketDataService,
    private readonly breakers: CircuitBreakerService,
    private readonly tradingEvents: TradingEventsService,
    private readonly auth: AuthService,
  ) {}

  onApplicationBootstrap(): void {
    const httpServer = this.httpAdapterHost.httpAdapter?.getHttpServer();
    if (!httpServer) {
      this.logger.warn('no HTTP server available; websocket stream disabled');
      return;
    }

    this.server = new WebSocketServer({ server: httpServer, path: '/stream' });
    this.server.on('connection', (socket) => this.onConnection(socket));

    this.subscriptions.push(
      this.priceEngine.updates.subscribe((update) => {
        this.broadcast('prices', {
          type: 'price',
          symbol: update.symbol,
          price: formatPrice(update.price),
          previousPrice: formatPrice(update.previousPrice),
          at: update.at.toISOString(),
        });
        void this.publishBook(update.symbol);
      }),
      this.breakers.trips.subscribe((state) => {
        this.broadcast('prices', {
          type: 'circuitBreaker',
          symbol: state.symbol,
          tripped: state.tripped,
          moveBps: state.moveBps,
          resumesAt: state.resumesAt?.toISOString() ?? null,
        });
      }),
      this.tradingEvents.events.subscribe((event) => {
        if (event.type === 'BOOK_CHANGED') {
          void this.publishBook(event.symbol);
          return;
        }
        this.sendToUser(event.userId, {
          type: event.type === 'FILL' ? 'fill' : 'order',
          payload: event.type === 'FILL' ? event.fill : event.order,
        });
      }),
    );

    this.heartbeat = setInterval(() => this.pingAll(), HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref();
    this.logger.log('websocket stream listening on /stream');
  }

  onModuleDestroy(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    for (const client of this.clients.keys()) client.close(1001, 'server shutting down');
    this.server?.close();
  }

  private onConnection(socket: WebSocket): void {
    const client: Client = { socket, channels: new Set(), alive: true };
    this.clients.set(socket, client);

    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('message', (data) => this.onMessage(client, data));
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));

    this.send(socket, {
      type: 'welcome',
      assets: this.marketData.list().map((asset) => ({
        symbol: asset.symbol,
        name: asset.name,
        price: formatPrice(this.marketData.currentPrice(asset.symbol) ?? asset.initialPrice),
        status: asset.status,
      })),
      channels: ['prices', 'book:<SYMBOL>', 'orders'],
    });
  }

  private onMessage(client: Client, data: RawData): void {
    let message: { type?: string; channels?: unknown; token?: unknown };
    try {
      message = JSON.parse(data.toString());
    } catch {
      this.send(client.socket, { type: 'error', message: 'Frames must be JSON.' });
      return;
    }

    if (message.type === 'ping') {
      this.send(client.socket, { type: 'pong', at: new Date().toISOString() });
      return;
    }

    if (message.type !== 'subscribe' && message.type !== 'unsubscribe') {
      this.send(client.socket, {
        type: 'error',
        message: 'Unknown frame type. Expected subscribe, unsubscribe or ping.',
      });
      return;
    }

    const channels = Array.isArray(message.channels)
      ? message.channels.filter((channel): channel is string => typeof channel === 'string')
      : [];

    if (message.type === 'unsubscribe') {
      for (const channel of channels) client.channels.delete(channel);
      this.send(client.socket, { type: 'subscribed', channels: [...client.channels] });
      return;
    }

    if (channels.includes('orders')) {
      const token = typeof message.token === 'string' ? message.token : undefined;
      try {
        client.userId = this.auth.verify(token ?? '').sub;
      } catch {
        this.send(client.socket, {
          type: 'error',
          message: 'The `orders` channel requires a valid bearer token in the subscribe frame.',
        });
        return;
      }
    }

    for (const channel of channels) {
      if (client.channels.size >= MAX_CHANNELS_PER_CLIENT) break;
      client.channels.add(channel);
    }
    this.send(client.socket, { type: 'subscribed', channels: [...client.channels] });

    // Send an immediate snapshot so a new subscriber is not blank until the next tick.
    for (const channel of client.channels) {
      if (channel.startsWith('book:')) void this.publishBook(channel.slice(5), client);
    }
  }

  private async publishBook(symbol: string, only?: Client): Promise<void> {
    const channel = `book:${symbol}`;
    const targets = only
      ? [only]
      : [...this.clients.values()].filter((client) => client.channels.has(channel));
    if (targets.length === 0) return;

    try {
      const snapshot = await this.marketData.getBookSnapshot(symbol);
      const payload = {
        type: 'book',
        symbol,
        mid: formatPrice(snapshot.mid),
        bids: snapshot.bids.slice(0, 8).map(toLevel),
        asks: snapshot.asks.slice(0, 8).map(toLevel),
        at: snapshot.at.toISOString(),
      };
      for (const client of targets) this.send(client.socket, payload);
    } catch {
      // An unknown symbol in a channel name is a client mistake, not a server fault.
    }
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const client of this.clients.values()) {
      if (client.channels.has(channel)) this.send(client.socket, payload);
    }
  }

  private sendToUser(userId: string, payload: unknown): void {
    for (const client of this.clients.values()) {
      if (client.userId === userId && client.channels.has('orders')) {
        this.send(client.socket, payload);
      }
    }
  }

  private send(socket: WebSocket, payload: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    // Payloads are DTOs and should hold no bigints; the replacer is a net so a
    // future field cannot take the stream down with a serialization error.
    socket.send(JSON.stringify(payload, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)));
  }

  private pingAll(): void {
    for (const [socket, client] of this.clients) {
      if (!client.alive) {
        socket.terminate();
        this.clients.delete(socket);
        continue;
      }
      client.alive = false;
      socket.ping();
    }
  }

  /** Exposed for tests and diagnostics. */
  get connectionCount(): number {
    return this.clients.size;
  }
}

function toLevel(level: { price: bigint; quantity: bigint }) {
  return { price: formatPrice(level.price), quantity: formatQuantity(level.quantity) };
}
