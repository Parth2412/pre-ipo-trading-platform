# Pre-IPO Trading Platform

A tokenized pre-IPO share trading platform: users trade fictional private-company shares against a
stablecoin balance, with a real matching engine, an event-sourced double-entry ledger, and portfolio
reconstruction at any point in the past.

Built with **TypeScript · NestJS · Fastify · PostgreSQL · Drizzle · Jest**.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Trading console (/)          REST (/…)          WebSocket (/stream)         │
├──────────────────────────────────────────────────────────────────────────────┤
│  Orders          Portfolio         Calculator          Admin                 │
│    │                 │                  │                 │                  │
│    ▼                 ▼                  ▼                 ▼                  │
│  Matching engine ── Market data (GBM prices · synthetic depth · breaker)      │
│    │                                                                          │
│    ▼                                                                          │
│  Double-entry ledger  ──►  PostgreSQL (append-only entries + projections)     │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Contents

- [Quick start](#quick-start)
- [The trading console](#the-trading-console)
- [API reference](#api-reference)
- [Architecture decisions](#architecture-decisions)
  - [1. Money is never a float](#1-money-is-never-a-float)
  - [2. The ledger is the source of truth](#2-the-ledger-is-the-source-of-truth)
  - [3. Point-in-time reconstruction is O(log n)](#3-point-in-time-reconstruction-is-olog-n)
  - [4. Concurrency: one global lock order](#4-concurrency-one-global-lock-order)
  - [5. Idempotency is a primary key, not a check](#5-idempotency-is-a-primary-key-not-a-check)
  - [6. Matching: price, then origin, then time](#6-matching-price-then-origin-then-time)
  - [7. Prices follow geometric Brownian motion](#7-prices-follow-geometric-brownian-motion)
  - [8. The circuit breaker is a monotonic deque](#8-the-circuit-breaker-is-a-monotonic-deque)
- [Testing](#testing)
- [Configuration](#configuration)
- [Known limitations](#known-limitations)
- [Project layout](#project-layout)

---

## Quick start

**Prerequisites:** Node 20+, pnpm (or npm), Docker.

```bash
pnpm install
cp .env.example .env

pnpm db:up          # PostgreSQL 16 on localhost:5435
pnpm db:migrate     # create the schema
pnpm db:seed        # list the four assets, create the demo traders

pnpm start:dev          # PORT=3001 pnpm start:dev if 3000 is taken
```

| What | Where |
|---|---|
| Trading console | <http://localhost:3000> |
| Swagger UI | <http://localhost:3000/docs> |
| WebSocket stream | `ws://localhost:3000/stream` |
| Health probe | <http://localhost:3000/health> |

Seeded accounts — all with password `Password123!`:

| Email | Role | Balance |
|---|---|---|
| `alice@example.com` | USER | $250,000 |
| `bob@example.com` | USER | $250,000 |
| `admin@example.com` | ADMIN | $1,000,000 |

Registering a new account credits `SIGNUP_BONUS_USD` (default $100,000).

### Listed assets

| Symbol | Company | Opening price | Annualised vol | Sector |
|---|---|---|---|---|
| `vSOL` | Solace AI | $420.00 | 70% | Artificial Intelligence |
| `vATL` | Atlas Robotics | $95.50 | 55% | Robotics |
| `vHLX` | Helix Biotech | $180.25 | 90% | Biotechnology |
| `vVAN` | Vantage Defense | $310.10 | 38% | Defense |

Volatility is set per company profile rather than uniformly — a clinical-stage biotech should move
far more violently than a defence contractor on government revenue, and it makes the circuit breaker
interesting.

### Try it in 30 seconds

```bash
B=http://localhost:3000
TOKEN=$(curl -s $B/auth/login -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"Password123!"}' | jq -r .accessToken)

# Mark the moment *before* trading, so the portfolio can be rebuilt as it was.
BEFORE=$(date -u +%Y-%m-%dT%H:%M:%S.000Z); sleep 1

# What does $5,000 of Solace AI buy right now?
curl -s $B/calculator -H 'content-type: application/json' \
  -d '{"symbol":"vSOL","usdAmount":"5000"}' | jq

# Buy it.
curl -s $B/orders -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H "idempotency-key: $(uuidgen)" \
  -d '{"symbol":"vSOL","side":"BUY","type":"MARKET","usdAmount":"5000"}' | jq

# Rebuild the portfolio as it stood before that trade, and prove the fast path
# agrees with a full fold of the raw ledger.
curl -s "$B/portfolio/history?at=$BEFORE&verify=true" \
  -H "authorization: Bearer $TOKEN" | jq '{mode, totals, reconciliation}'

# ...and how it looks now.
curl -s "$B/portfolio?verify=true" -H "authorization: Bearer $TOKEN" | jq '{totals, reconciliation}'
```

The quote and the fill agree exactly — the same share count at the same average price — because both
walk the same book, and the synthetic ladder is stable for the life of a price tick. (The prices
themselves differ run to run; the market is live.)

The reconstruction reports `"consistent": true`: the O(log n) running-balance read and an independent
`SUM(delta)` fold of the ledger produced identical numbers. Before the trade it shows the untouched
$250,000 and no holdings; after it, one position and the cash to match.

> A reconstruction timestamped before the account existed correctly returns an empty portfolio, so
> pick an instant after signing in.

---

## The trading console

`GET /` serves a self-contained trading desk — no build step, no framework, no external requests.

- Live asset list with flash-on-tick and `HALTED` / `BREAKER` badges
- Depth-shaded order book with cumulative totals and the spread in basis points
- Price chart seeded from history and extended live over the WebSocket
- Order ticket that quotes through `POST /calculator` as you type, then places the real order
- Orders / Holdings / Trades tabs with inline cancel
- A point-in-time panel: pick an instant, get the reconstructed portfolio **and** the reconciliation
  result

---

## API reference

Interactive documentation is at `/docs`; `docs/openapi.json` is generated from the live decorator
metadata (`pnpm openapi`), and `docs/postman_collection.json` is a ready-to-run Postman collection
that captures your bearer token and generates a fresh `Idempotency-Key` per send.

**Conventions**

- Prices, quantities and cash are **decimal strings** in both directions — `"420.000000"`, not
  `420.0`. Sending JSON numbers for money would reintroduce the float error the backend is built to
  avoid.
- Every failure returns one envelope:
  ```json
  { "error": { "code": "INSUFFICIENT_FUNDS", "message": "…", "details": {} },
    "path": "/orders", "timestamp": "2026-08-27T15:04:05.000Z" }
  ```
  Switch on `error.code`; wording may change.
- Authentication is `Authorization: Bearer <jwt>`. Market data and the calculator are public;
  everything that moves money is not.

### Auth

| Method | Path | Description |
|---|---|---|
| `POST` | `/auth/register` | Create an account, credited with the welcome balance |
| `POST` | `/auth/login` | Exchange credentials for a bearer token |
| `GET` | `/auth/me` | The authenticated principal |

### Market data — public

| Method | Path | Description |
|---|---|---|
| `GET` | `/assets` | The tradable universe: mark, top of book, 24h stats, breaker state |
| `GET` | `/assets/:symbol` | Asset detail with the aggregated order book |
| `GET` | `/assets/:symbol/history` | Price ticks, oldest first — `from`, `to`, `limit` |
| `GET` | `/assets/:symbol/book` | Resting user orders merged with synthetic depth — `depth` |

### Calculator — public, no side effects

| Method | Path | Description |
|---|---|---|
| `POST` | `/calculator` | `usdAmount` → shares, or `quantity` → USD. Optional `limitPrice` |

Returns shares, gross notional, fee, net cash, effective price, slippage in bps, the book levels the
order would consume, and warnings. It walks exactly the book the matching engine walks, so the quote
is what a market order placed in the same tick actually pays.

### Orders — authenticated

| Method | Path | Description |
|---|---|---|
| `POST` | `/orders` | Place an order. **`Idempotency-Key` header required** |
| `GET` | `/orders` | Your orders, newest first — `symbol`, `status`, `limit`, `offset` |
| `GET` | `/orders/trades` | Your executions, each with the position state that followed |
| `GET` | `/orders/:id` | One order with its fills |
| `DELETE` | `/orders/:id` | Cancel a resting order, releasing the unfilled reservation |

**Request body**

| Field | Required | Notes |
|---|---|---|
| `symbol` | yes | e.g. `vSOL` |
| `side` | yes | `BUY` \| `SELL` |
| `type` | yes | `MARKET` \| `LIMIT` |
| `quantity` | conditional | Shares. Required for LIMIT and for every SELL |
| `usdAmount` | conditional | MARKET BUY only; mutually exclusive with `quantity` |
| `limitPrice` | LIMIT only | Must be a multiple of the asset tick size |
| `timeInForce` | no | Defaults to `IOC` for MARKET, `GTC` for LIMIT |

**Order statuses**

| Status | Meaning |
|---|---|
| `OPEN` | Resting on the book, nothing filled yet |
| `PARTIALLY_FILLED` | Some quantity filled, the rest still working |
| `FILLED` | Complete |
| `CANCELLED` | Cancelled by the user, or an IOC remainder that could not fill |
| `REJECTED` | Reserved for engine-level rejection |

### Portfolio — authenticated

| Method | Path | Description |
|---|---|---|
| `GET` | `/portfolio` | Holdings, cost basis, realised + unrealised P&L, totals |
| `GET` | `/portfolio/history?at=` | **Reconstruct the portfolio at a past instant** |
| `GET` | `/portfolio/timeline` | Equity curve — `from`, `to`, `points` |
| `GET` | `/portfolio/ledger` | The raw double-entry statement |

Both portfolio endpoints accept `verify=true`, which additionally recomputes the whole portfolio from
raw ledger deltas and reports any drift. See
[decision 3](#3-point-in-time-reconstruction-is-olog-n).

### Admin — `ADMIN` role

| Method | Path | Description |
|---|---|---|
| `POST` | `/admin/assets/:symbol/halt` | Halt trading. New orders return `MARKET_HALTED` |
| `POST` | `/admin/assets/:symbol/resume` | Lift the halt |
| `POST` | `/admin/assets/:symbol/price` | Publish an out-of-band mark (simulation control) |

### WebSocket — `/stream`

| Channel | Auth | Payload |
|---|---|---|
| `prices` | public | Every price tick, plus circuit-breaker trips |
| `book:<SYMBOL>` | public | Top of book after each tick |
| `orders` | bearer token in the subscribe frame | Your own order and fill events |

```js
const ws = new WebSocket('ws://localhost:3000/stream');
ws.onopen = () => ws.send(JSON.stringify({
  type: 'subscribe', channels: ['prices', 'book:vSOL', 'orders'], token: '<jwt>',
}));
```

Events are published **after** the producing transaction commits, so a subscriber can never observe a
fill that later rolls back.

### Error codes

| Code | HTTP | When |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Malformed or contradictory request |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | `POST /orders` without the header |
| `UNAUTHORIZED` | 401 | Missing, invalid or expired token |
| `FORBIDDEN` | 403 | Non-admin calling an admin route |
| `ASSET_NOT_FOUND` / `ORDER_NOT_FOUND` | 404 | Unknown symbol or order |
| `ORDER_NOT_CANCELLABLE` | 409 | Order already terminal |
| `IDEMPOTENT_REQUEST_IN_FLIGHT` | 409 | An identical request is still running |
| `INSUFFICIENT_FUNDS` / `INSUFFICIENT_SHARES` | 422 | Not enough cash or shares |
| `NO_LIQUIDITY` | 422 | Market order with nothing to trade against |
| `IDEMPOTENCY_KEY_REUSED` | 422 | Same key, different body |
| `CIRCUIT_BREAKER_TRIPPED` / `MARKET_HALTED` | 423 | Asset temporarily untradable |
| `RATE_LIMITED` | 429 | Throttle exceeded |

---

## Architecture decisions

### 1. Money is never a float

Every monetary value is a `bigint` holding a **scaled integer**:

| Quantity | Scale | Example |
|---|---|---|
| Price | 1e6 | `$420.00` → `420_000_000n` |
| Share quantity | 1e8 | `1.5 shares` → `150_000_000n` |
| Cash | 1e6 | `$1,234.56` → `1_234_560_000n` |

IEEE-754 doubles cannot represent `0.1` exactly, so a ledger built on `number` accumulates drift that
eventually breaks the invariant *sum of ledger deltas equals the materialised balance*. With scaled
integers, addition and subtraction are **exact**; multiplication and division are the only lossy
operations and are funnelled through helpers with one explicit rounding rule
(`src/common/money.ts`).

Two rounding choices are deliberate:

- **Fees round up.** A fee that rounds to less than the smallest unit must not vanish, or the venue
  is short a remainder on every trade.
- **Shares-for-cash rounds down.** A buyer converting a fixed USD amount can never be allocated more
  shares than the amount actually pays for. A `$5,000` market buy is verified to produce a total of
  `$4,999.99`, never `$5,000.01`.

Money crosses the API as decimal **strings** so a JavaScript client cannot undo any of this by
parsing it into a `number`.

### 2. The ledger is the source of truth

Every movement of cash or shares is an append-only row in `ledger_entries`, against one of four
accounts per user:

| Account | Holds |
|---|---|
| `CASH` | Spendable stablecoin |
| `CASH_RESERVED` | Earmarked for resting BUY orders |
| `POSITION` | Freely sellable shares |
| `POSITION_RESERVED` | Earmarked for resting SELL orders |

The `balances` table is a **projection**, updated in the same transaction under the same row lock.
Splitting reserved from available is what makes the reservation model honest: a resting BUY holds its
cash in `CASH_RESERVED` where a second order cannot spend it, and a resting SELL holds the shares
themselves, so the same shares cannot be sold twice by two concurrent orders.

A view proves the two agree:

```sql
SELECT * FROM balances_integrity;   -- any row is a bug
```

It compares each materialised balance against `SUM(delta)` over the ledger. The test suite asserts it
is empty after **every** concurrency scenario.

### 3. Point-in-time reconstruction is O(log n)

> *"What did this portfolio look like at 14:32 last Tuesday?"*

The naive answer folds every ledger entry and replays every fill on each request. That is
**O(account history)** and degrades forever as a user trades — the one query shape you cannot afford
to write that way, because it is also the one users hit repeatedly when scrubbing a chart.

Two sets of columns, both written inside the transaction that produced the event, avoid it:

- **`ledger_entries.balance_after`** — the running balance of that account, written under the same row
  lock as the balance update, so it can never disagree with it.
- **`fills.post_quantity` / `post_avg_cost` / `post_realized_pnl`** — the running position state
  immediately after each execution.

Reconstruction at `T` then becomes **three index seeks**:

| Question | Query | Index |
|---|---|---|
| Cash then? | newest ledger entry per cash account `WHERE created_at <= T` | `ledger_entries_pit_idx` |
| Holdings and basis then? | newest fill per symbol `WHERE created_at <= T` | `fills_position_pit_idx` |
| Worth what then? | newest price tick per symbol `WHERE created_at <= T` | `price_ticks_symbol_time_idx` |

Each is a `DISTINCT ON` whose leading index columns match the predicate exactly, so cost is O(log n)
per account and per asset, **independent of trading volume**. Holdings are valued at the price that
was actually printed then, never at today's price.

**Why the slow path still exists.** A denormalised running total is only as trustworthy as the
invariant maintaining it. `?verify=true` recomputes the same portfolio the obviously-correct way —
`SUM(delta)` over every ledger entry, plus a full replay of every fill — and reports drift:

```json
"reconciliation": {
  "consistent": true, "cashDrift": "0.000000", "positionDrift": [],
  "ledgerEntriesFolded": 16, "fillsReplayed": 3
}
```

It is the proof that the fast path is not lying, and the e2e suite asserts the two agree at every
checkpoint of an account's life.

**Cost basis** uses **weighted average cost**, not FIFO/LIFO lot tracking. WAC is a single
`(quantity, avgCost)` pair, so the whole position state fits in three columns and reconstruction stays
an index seek; lot tracking would require replaying a lot table and give back the O(n) cost. It is
also the convention for fractional/tokenized share products, where lots are not individually
identifiable. Fees are capitalised into the basis on a buy and deducted from proceeds on a sell, so
realised P&L is net of trading costs.

### 4. Concurrency: one global lock order

Every write path takes locks in the same **total order**:

1. **Symbol advisory lock** — only one order at a time is matched against a given asset's book.
2. **`SELECT … FOR UPDATE` on resting orders**, taken *while planning*, so a concurrent taker cannot
   plan against quantity this transaction is about to consume.
3. **User advisory locks, sorted ascending**, once the counterparties are known.

Because the order is total, two transactions can never hold resources the other needs in reverse —
the engine is **deadlock-free by construction** rather than by retry loop.

That is also why `READ COMMITTED` is the right isolation level here: the anomalies `SERIALIZABLE`
would prevent cannot occur under explicit row locks, and we avoid forcing serialization-failure
retries onto the hot order path.

Measured behaviour (`test/concurrency.e2e-spec.ts`):

| Scenario | Result |
|---|---|
| 20 simultaneous requests, same `Idempotency-Key` | 1 order created, 19 × `409`, **1** database row |
| 25 simultaneous $9,000 buys against $100,000 | ≤ 11 filled, rest `INSUFFICIENT_FUNDS`, cash reconciles exactly |
| 12 simultaneous sells of a 20-share position | never oversold |
| 10 simultaneous cancels of one order | 1 × `200`, 9 × `409`; reservation released **once** |
| 10 takers competing for one 100-share resting order | consumed, never over-consumed |

Every case ends with zero negative balances and zero rows in `balances_integrity`.

### 5. Idempotency is a primary key, not a check

`POST /orders` requires an `Idempotency-Key` header — order placement is the one endpoint where a
network retry costs real money, so the client is made to declare intent.

The concurrency primitive is the **table's primary key**. Racing requests all attempt the INSERT;
Postgres lets exactly one win, and the loser is told which case it hit:

| Case | Response |
|---|---|
| Original completed | Stored response replayed verbatim, `Idempotent-Replay: true` |
| Original still running | `409 IDEMPOTENT_REQUEST_IN_FLIGHT` — returning a guess would be worse |
| Same key, different body | `422 IDEMPOTENCY_KEY_REUSED` — silently replaying would hide a client bug about to lose an order |

A *deliberate* rejection (insufficient funds, tripped breaker) is recorded as a real outcome, so
retrying the key returns the same rejection rather than re-running the engine. An *unexpected*
failure releases the marker so the client may safely retry.

### 6. Matching: price, then origin, then time

Incoming orders are matched against a merged pool of **resting user orders** and **synthetic
market-maker depth**, ranked by:

1. **Price** — the taker gets the best price available, whichever it comes from.
2. **Origin** — at an equal price, resting *user* orders fill before synthetic depth. A real order
   queued at a price should never be skipped in favour of a market maker quoting the same price.
3. **Time** — among user orders at one price, oldest first. Queue position is earned by arriving
   early and cannot be jumped.

**Self-match prevention** works by exclusion: a taker's own resting orders are skipped, not cancelled,
so their queue position survives trading on the other side of their own book.

**Partial fills** arise two ways, both exercised by the suite:
- sweeping several book levels within a single order, when depth at the touch is thin;
- a resting limit order filled a slice at a time by successive price ticks — `RestingOrdersScheduler`
  re-runs the matcher on every tick. Without it, a limit order away from the touch could only ever be
  filled by another user crossing it.

A resting order is a **maker** — the market came to it — so it pays the maker fee even though the tick
pass is what triggers execution.

**Synthetic depth** is derived, not stored, from a generator seeded with `(symbol, price bucket)`.
That buys two properties: within a tick the ladder is stable, so the calculator's quote matches what a
market order actually pays; and across restarts the same market replays identically. Sizes grow with
depth and the quoted spread widens with volatility, so sweeping a large order costs progressively more
— real slippage, not a flat fill at mid.

### 7. Prices follow geometric Brownian motion

```
S(t+dt) = S(t) · exp( (μ − σ²/2)·dt + σ·√dt·Z ),   Z ~ N(0,1)
```

GBM rather than a random walk on the price itself, because it is multiplicative: prices stay strictly
positive, and a 1% move costs the same in log space at $95 as at $420 — which is how equities behave.
The `−σ²/2` term is the Itô correction that keeps the *expected* return equal to μ rather than
μ + σ²/2.

The generator is seeded (mulberry32 + Box–Muller), so a given `PRICE_RANDOM_SEED` replays the exact
same market — which is what makes the price path reproducible.

`MARKET_TIME_ACCELERATION` (default 3600 — one wall second is one market hour) compresses simulated
time. Real annualised volatility spread over real seconds produces roughly 10 bps of movement a
minute, which makes the product undemonstrable and the circuit breaker unreachable. The mathematics
stays honest; only the clock changes.

### 8. The circuit breaker is a monotonic deque

> \>15% price move in 60s → reject new orders on that asset for 30s

"Moved 15%" is measured as the full **peak-to-trough range** inside the window, not
first-tick-to-last-tick. A price that spikes 20% and retraces has still dislocated, and a
first-to-last comparison would miss it entirely — there is a test for exactly that case.

The range query runs on **every order placement**, so it must not be a window rescan. Two *monotonic
deques* — one non-increasing, one non-decreasing — keep the window maximum and minimum at their heads.
Each sample is pushed and popped at most once, giving **O(1) amortised insertion and O(1) extrema
lookup** regardless of tick rate. Verified against a brute-force scan over a 2,000-sample stream.

A halt is the operator's equivalent: persisted on the asset, and only an operator lifts it. The
breaker trips and clears on its own.

---

## Testing

```bash
pnpm test        # everything
pnpm test:unit   # pure domain logic, no I/O
pnpm test:e2e    # boots the app against a real PostgreSQL database
pnpm test:cov    # with coverage
```

**165 tests, all green.**

| Suite | Tests | Covers |
|---|---|---|
| `money`, `random`, `sliding-window-extrema` | 41 | Fixed-point arithmetic, rounding rules, seeded RNG, deque extrema vs brute force |
| `order-book`, `depth-ladder` | 23 | Book walking, budget-vs-liquidity exhaustion, ladder shape and determinism |
| `position`, `match-plan` | 22 | WAC accounting, realised P&L, price/origin/time ordering, self-match exclusion |
| `circuit-breaker` | 8 | Trip, peak-to-trough detection, window ageing, cooldown, per-asset isolation |
| `auth.e2e` | 10 | Registration, tokens, guard defaults, role enforcement |
| `market-data.e2e` | 16 | Assets, history, book ordering, calculator budget invariants and slippage |
| `trading.e2e` | 34 | Happy path, every rejection, idempotency, partial fills, cancellation, cross-user matching, breaker, halts |
| `portfolio.e2e` | 13 | Live portfolio, point-in-time reconstruction, reconciliation, equity curve, ledger |
| `concurrency.e2e` | 6 | Idempotency races, overdraw, oversell, cancel storms, contested book |

The e2e suite runs against a **dedicated test database** (`TEST_DATABASE_URL`), created and migrated
automatically, rather than wrapping each test in a rolled-back transaction — the engine relies on
advisory locks and `FOR UPDATE` across several connections, behaviour a single wrapping transaction
would hide.

Tests freeze the price process (`PRICE_ENGINE_ENABLED=false`) and move prices explicitly through the
admin control, so nothing depends on a random walk cooperating.

---

## Configuration

Everything is in `.env` — see `.env.example` for the annotated list.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `…:5435/preipo` | Primary database |
| `TEST_DATABASE_URL` | `…/preipo_test` | e2e database, created if missing |
| `JWT_SECRET` / `JWT_EXPIRES_IN` | — / `12h` | Token signing |
| `SIGNUP_BONUS_USD` | `100000` | Welcome balance |
| `PRICE_TICK_INTERVAL_MS` | `1000` | Simulation cadence |
| `PRICE_RANDOM_SEED` | `20240601` | Makes the market reproducible |
| `PRICE_ENGINE_ENABLED` | `true` | `false` freezes prices |
| `MARKET_TIME_ACCELERATION` | `3600` | Market seconds per wall second |
| `BOOK_LEVELS` / `BOOK_NOTIONAL_PER_LEVEL_USD` / `BOOK_SPREAD_BPS` | `10` / `25000` / `12` | Synthetic depth shape |
| `TAKER_FEE_BPS` / `MAKER_FEE_BPS` | `10` / `0` | Fee schedule |
| `CIRCUIT_BREAKER_THRESHOLD_BPS` | `1500` | 15% |
| `CIRCUIT_BREAKER_WINDOW_MS` | `60000` | 60s |
| `CIRCUIT_BREAKER_COOLDOWN_MS` | `30000` | 30s |
| `RATE_LIMIT_TTL_MS` / `RATE_LIMIT_LIMIT` | `60000` / `300` | Throttle |

---

## Known limitations

Stated plainly, because knowing where a system stops is part of the design.

**Single-node engine.** Circuit-breaker windows and the price simulation live in process memory. Two
API instances would each run their own simulation and their own breaker. The *ledger* is safe under
multiple instances — it is guarded by database locks — but the market would not be coherent. Fixing
it means moving price generation to one publisher (or a job) and breaker state to Redis.

**No short selling or margin.** Balances are constrained to be non-negative at the database level, so
every sale must be covered. Short selling was in scope as a stretch goal and was deliberately left
out rather than half-built: it needs a margin model, maintenance calls and liquidation, and each of
those interacts with the cost-basis and reconstruction logic that carries the most weight here. A
correct system without shorts is worth more than a plausible one with them.

**History is event-time, not bitemporal.** Reconstruction filters on `created_at`. A transaction that
started before `T` but commits after a history query has run would appear in a later query for the
same `T`, so a past snapshot is not strictly immutable under concurrent writes. Production systems
solve this with a commit-time column or full bitemporality; here it would have added a dimension to
every index for a case the simulation cannot actually produce.

**Synthetic liquidity is infinite over time.** The ladder regenerates each tick, so the market can
absorb unlimited flow across ticks. There is no inventory model and no market-maker P&L.

**Prices ignore order flow.** A large sweep pays slippage but does not move the mark; the GBM process
is exogenous. A real venue's price *is* the trading. Adding impact is a contained change to the price
engine.

**The administrative price control is a simulation tool.** `POST /admin/assets/:symbol/price` prints
a mark outside the random walk. It exists so volatility behaviour can be demonstrated and tested on
demand. It is admin-gated and audited into `price_ticks`, but it has no place in a real venue.

**Auth is intentionally minimal.** Email, password, JWT, one role bit. No refresh tokens, no session
revocation, no password reset, no MFA. The brief said not to over-invest here, and the hours went to
the ledger instead.

**Idempotency records are never pruned.** The table grows without bound. A production system would
expire keys after 24–48 hours with a scheduled job.

**Fees accrue to nobody.** They leave user balances and are not credited to a venue account, so the
platform's own books are not modelled. Every *user's* books balance exactly.

---

## Project layout

```
src/
  common/          fixed-point money, seeded RNG, monotonic-deque window,
                   error taxonomy, error envelope, SQL row coercion
  config/          typed configuration loaded once at boot
  database/        SQL migrations (authoritative), Drizzle schema, migrator, seed
  auth/            registration, login, global bearer guard, role guard
  ledger/          double-entry posting, running balances, point-in-time reads
  assets/          GBM price engine, synthetic depth ladder, market data,
                   circuit breaker, public market endpoints
  calculator/      side-effect-free order sizing
  orders/          matching engine, match planning, WAC position accounting,
                   idempotency, repository, tick-driven resting-order matcher
  portfolio/       valuation, point-in-time reconstruction, reconciliation
  admin/           halt, resume, out-of-band mark price
  realtime/        trading event bus, WebSocket gateway
public/            the trading console
test/              e2e specs and the Nest + PostgreSQL harness
docs/              generated OpenAPI document, Postman collection
```

Files worth reading first, in order: `src/common/money.ts`,
`src/database/migrations/0001_initial_schema.sql`, `src/ledger/ledger.service.ts`,
`src/orders/matching-engine.service.ts`, `src/portfolio/portfolio.service.ts`.
