-- ---------------------------------------------------------------------------
-- Pre-IPO trading platform — initial schema
--
-- Money model: every monetary column is a BIGINT holding a scaled integer.
--   price / cash : scale 1e6   (6 dp)
--   quantity     : scale 1e8   (8 dp)
-- See src/common/money.ts. Storing scaled integers keeps ledger arithmetic
-- exact and makes SUM() over the ledger a lossless integrity check.
--
-- Status/enum columns are TEXT + CHECK rather than native ENUM types so that
-- adding a value is an ordinary migration instead of a catalogue rewrite.
-- ---------------------------------------------------------------------------

CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Case-insensitive uniqueness: nobody registers Alice@x.com twice as alice@x.com.
CREATE UNIQUE INDEX users_email_uidx ON users (lower(email));

-- ---------------------------------------------------------------------------
-- Tradable assets. Drift/volatility drive the geometric Brownian motion price
-- process; tick and lot sizes define the market microstructure.
-- ---------------------------------------------------------------------------
CREATE TABLE assets (
    symbol              TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    sector              TEXT NOT NULL DEFAULT '',
    initial_price       BIGINT NOT NULL CHECK (initial_price > 0),
    annual_drift_bps    INTEGER NOT NULL DEFAULT 0,
    annual_vol_bps      INTEGER NOT NULL CHECK (annual_vol_bps >= 0),
    tick_size           BIGINT NOT NULL CHECK (tick_size > 0),
    lot_size            BIGINT NOT NULL CHECK (lot_size > 0),
    min_order_notional  BIGINT NOT NULL DEFAULT 0 CHECK (min_order_notional >= 0),
    status              TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'HALTED')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- ---------------------------------------------------------------------------
-- Immutable price history. Every simulated tick is appended; the "current"
-- price is simply the newest row. Point-in-time valuation reads the newest row
-- at or before the requested timestamp.
-- ---------------------------------------------------------------------------
CREATE TABLE price_ticks (
    id         BIGSERIAL PRIMARY KEY,
    symbol     TEXT NOT NULL REFERENCES assets (symbol) ON DELETE CASCADE,
    price      BIGINT NOT NULL CHECK (price > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX price_ticks_symbol_time_idx ON price_ticks (symbol, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- Audit of asset halts and resumes performed by an administrator.
-- ---------------------------------------------------------------------------
CREATE TABLE asset_status_events (
    id             BIGSERIAL PRIMARY KEY,
    symbol         TEXT NOT NULL REFERENCES assets (symbol) ON DELETE CASCADE,
    status         TEXT NOT NULL CHECK (status IN ('ACTIVE', 'HALTED')),
    reason         TEXT NOT NULL DEFAULT '',
    actor_user_id  UUID REFERENCES users (id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX asset_status_events_symbol_idx ON asset_status_events (symbol, id DESC);

-- ---------------------------------------------------------------------------
-- Materialised balances.
--
-- These are a *projection*: the ledger below is the source of truth. Keeping a
-- projection lets the hot path (order placement) read and lock one row per
-- account with SELECT ... FOR UPDATE instead of folding the entire history.
-- `balances_integrity` (a view, further down) proves the two agree.
--
-- Four accounts per user model settlement properly:
--   CASH              spendable stablecoin
--   CASH_RESERVED     earmarked for resting BUY limit orders
--   POSITION          freely sellable shares
--   POSITION_RESERVED shares earmarked for resting SELL limit orders
-- ---------------------------------------------------------------------------
CREATE TABLE balances (
    id           BIGSERIAL PRIMARY KEY,
    user_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    account      TEXT NOT NULL
                 CHECK (account IN ('CASH', 'CASH_RESERVED', 'POSITION', 'POSITION_RESERVED')),
    asset_symbol TEXT REFERENCES assets (symbol) ON DELETE RESTRICT,
    amount       BIGINT NOT NULL DEFAULT 0 CHECK (amount >= 0),
    version      BIGINT NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    -- Cash accounts carry no symbol; position accounts must carry one.
    CONSTRAINT balances_symbol_matches_account CHECK (
        (account IN ('CASH', 'CASH_RESERVED') AND asset_symbol IS NULL)
        OR (account IN ('POSITION', 'POSITION_RESERVED') AND asset_symbol IS NOT NULL)
    )
);

CREATE UNIQUE INDEX balances_owner_uidx
    ON balances (user_id, account, COALESCE(asset_symbol, ''));

-- ---------------------------------------------------------------------------
-- Append-only double-entry ledger — the source of truth for every balance.
--
-- `balance_after` is the running balance of (user_id, account, asset_symbol)
-- immediately after this entry. It is written inside the same transaction that
-- holds the FOR UPDATE lock on the balance row, so it is always consistent.
-- It turns point-in-time balance lookup into an index seek:
--
--   SELECT balance_after FROM ledger_entries
--    WHERE user_id = $1 AND account = $2 AND asset_symbol IS NOT DISTINCT FROM $3
--      AND created_at <= $4
--    ORDER BY id DESC LIMIT 1;
--
-- ...instead of an O(history) SUM(delta) fold.
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_entries (
    id            BIGSERIAL PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    account       TEXT NOT NULL
                  CHECK (account IN ('CASH', 'CASH_RESERVED', 'POSITION', 'POSITION_RESERVED')),
    asset_symbol  TEXT REFERENCES assets (symbol) ON DELETE RESTRICT,
    delta         BIGINT NOT NULL,
    balance_after BIGINT NOT NULL CHECK (balance_after >= 0),
    entry_type    TEXT NOT NULL CHECK (entry_type IN (
                      'DEPOSIT',
                      'WITHDRAWAL',
                      'ORDER_RESERVE',
                      'ORDER_RELEASE',
                      'TRADE_BUY',
                      'TRADE_SELL',
                      'FEE'
                  )),
    ref_type      TEXT CHECK (ref_type IN ('ORDER', 'FILL', 'ADMIN', 'SIGNUP')),
    ref_id        TEXT,
    memo          TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Point-in-time running-balance lookup (the hot path for /portfolio/history).
CREATE INDEX ledger_entries_pit_idx
    ON ledger_entries (user_id, account, COALESCE(asset_symbol, ''), created_at DESC, id DESC);
-- Statement-level history feed and full-fold integrity verification.
CREATE INDEX ledger_entries_user_time_idx ON ledger_entries (user_id, id);
CREATE INDEX ledger_entries_ref_idx ON ledger_entries (ref_type, ref_id);

-- ---------------------------------------------------------------------------
-- Orders.
--
-- `reserved_cash` / `reserved_quantity` track what is still earmarked for this
-- order, so cancellation releases exactly what remains and never more.
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    symbol             TEXT NOT NULL REFERENCES assets (symbol) ON DELETE RESTRICT,
    side               TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    type               TEXT NOT NULL CHECK (type IN ('MARKET', 'LIMIT')),
    time_in_force      TEXT NOT NULL CHECK (time_in_force IN ('IOC', 'GTC')),
    limit_price        BIGINT CHECK (limit_price IS NULL OR limit_price > 0),
    quantity           BIGINT NOT NULL CHECK (quantity > 0),
    filled_quantity    BIGINT NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
    filled_notional    BIGINT NOT NULL DEFAULT 0 CHECK (filled_notional >= 0),
    fees_paid          BIGINT NOT NULL DEFAULT 0 CHECK (fees_paid >= 0),
    reserved_cash      BIGINT NOT NULL DEFAULT 0 CHECK (reserved_cash >= 0),
    reserved_quantity  BIGINT NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
    status             TEXT NOT NULL CHECK (status IN (
                           'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED'
                       )),
    reject_reason      TEXT,
    idempotency_key    TEXT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT orders_limit_price_required CHECK (
        (type = 'LIMIT' AND limit_price IS NOT NULL) OR (type = 'MARKET' AND limit_price IS NULL)
    ),
    CONSTRAINT orders_not_overfilled CHECK (filled_quantity <= quantity)
);

CREATE UNIQUE INDEX orders_user_idempotency_uidx ON orders (user_id, idempotency_key);
CREATE INDEX orders_user_created_idx ON orders (user_id, created_at DESC);
-- Price-time priority scan over the resting book.
CREATE INDEX orders_resting_book_idx
    ON orders (symbol, side, limit_price, created_at, id)
    WHERE status IN ('OPEN', 'PARTIALLY_FILLED');

-- ---------------------------------------------------------------------------
-- Fills (executions). One row per side of a trade.
--
-- The `post_*` columns snapshot the user's running position state for that
-- symbol immediately after the fill. This is what makes point-in-time cost
-- basis and realised P&L an O(log n) index seek rather than a replay of every
-- execution the user has ever made.
-- ---------------------------------------------------------------------------
CREATE TABLE fills (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seq               BIGSERIAL NOT NULL,
    order_id          UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    user_id           UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    symbol            TEXT NOT NULL REFERENCES assets (symbol) ON DELETE RESTRICT,
    side              TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    quantity          BIGINT NOT NULL CHECK (quantity > 0),
    price             BIGINT NOT NULL CHECK (price > 0),
    notional          BIGINT NOT NULL CHECK (notional >= 0),
    fee               BIGINT NOT NULL DEFAULT 0 CHECK (fee >= 0),
    liquidity_role    TEXT NOT NULL CHECK (liquidity_role IN ('TAKER', 'MAKER')),
    counterparty_type TEXT NOT NULL CHECK (counterparty_type IN ('USER', 'SYNTHETIC')),
    counter_order_id  UUID REFERENCES orders (id) ON DELETE SET NULL,
    post_quantity     BIGINT NOT NULL CHECK (post_quantity >= 0),
    post_avg_cost     BIGINT NOT NULL CHECK (post_avg_cost >= 0),
    post_realized_pnl BIGINT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Point-in-time position snapshot lookup (the hot path for /portfolio/history).
CREATE INDEX fills_position_pit_idx ON fills (user_id, symbol, created_at DESC, seq DESC);
CREATE INDEX fills_order_idx ON fills (order_id, seq);
CREATE INDEX fills_symbol_time_idx ON fills (symbol, created_at DESC);
CREATE INDEX fills_user_time_idx ON fills (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Idempotency records.
--
-- The primary key is the concurrency primitive: two racing requests with the
-- same key both attempt the INSERT, exactly one wins, and the loser either
-- replays the stored response or is told the original is still in flight.
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_records (
    user_id         UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    endpoint        TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash    TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('IN_FLIGHT', 'COMPLETED')),
    response_status INTEGER,
    response_body   JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    completed_at    TIMESTAMPTZ,
    PRIMARY KEY (user_id, endpoint, idempotency_key)
);

CREATE INDEX idempotency_records_created_idx ON idempotency_records (created_at);

-- ---------------------------------------------------------------------------
-- Circuit breaker trips, kept for audit and for exposing breaker state on the
-- asset detail endpoint after a process restart.
-- ---------------------------------------------------------------------------
CREATE TABLE circuit_breaker_events (
    id              BIGSERIAL PRIMARY KEY,
    symbol          TEXT NOT NULL REFERENCES assets (symbol) ON DELETE CASCADE,
    move_bps        INTEGER NOT NULL,
    threshold_bps   INTEGER NOT NULL,
    window_ms       INTEGER NOT NULL,
    reference_price BIGINT NOT NULL,
    extreme_price   BIGINT NOT NULL,
    tripped_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX circuit_breaker_events_symbol_idx ON circuit_breaker_events (symbol, id DESC);

-- ---------------------------------------------------------------------------
-- Integrity view: the materialised projection must equal the ledger fold.
-- Any row returned by this view is a bug. Asserted by the test suite.
-- ---------------------------------------------------------------------------
CREATE VIEW balances_integrity AS
SELECT
    b.user_id,
    b.account,
    b.asset_symbol,
    b.amount                     AS projected_amount,
    COALESCE(l.total_delta, 0)   AS ledger_amount,
    b.amount - COALESCE(l.total_delta, 0) AS drift
FROM balances b
LEFT JOIN (
    SELECT user_id, account, asset_symbol, SUM(delta) AS total_delta
    FROM ledger_entries
    GROUP BY user_id, account, asset_symbol
) l
    ON l.user_id = b.user_id
   AND l.account = b.account
   AND l.asset_symbol IS NOT DISTINCT FROM b.asset_symbol
WHERE b.amount <> COALESCE(l.total_delta, 0);
