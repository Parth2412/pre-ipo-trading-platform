import { parsePrice, parseQuantity } from '../common/money';

export interface SeedAsset {
  readonly symbol: string;
  readonly name: string;
  readonly description: string;
  readonly sector: string;
  readonly initialPrice: bigint;
  /** Annual expected return, in basis points, used as the GBM drift term. */
  readonly annualDriftBps: number;
  /** Annualised volatility, in basis points, used as the GBM diffusion term. */
  readonly annualVolBps: number;
  readonly tickSize: bigint;
  readonly lotSize: bigint;
  readonly minOrderNotional: bigint;
}

/**
 * The four fictional pre-IPO names the platform lists.
 *
 * Volatility is set per company profile rather than uniformly: a clinical-stage
 * biotech should move far more violently than a defence contractor with
 * government revenue, and the circuit breaker becomes interesting as a result.
 */
export const SEED_ASSETS: readonly SeedAsset[] = [
  {
    symbol: 'vSOL',
    name: 'Solace AI',
    description: 'Frontier model lab building enterprise reasoning agents.',
    sector: 'Artificial Intelligence',
    initialPrice: parsePrice('420.00'),
    annualDriftBps: 1800,
    annualVolBps: 7000,
    tickSize: parsePrice('0.01'),
    lotSize: parseQuantity('0.00001'),
    minOrderNotional: parsePrice('1.00'),
  },
  {
    symbol: 'vATL',
    name: 'Atlas Robotics',
    description: 'Humanoid warehouse robotics and autonomous material handling.',
    sector: 'Robotics',
    initialPrice: parsePrice('95.50'),
    annualDriftBps: 1200,
    annualVolBps: 5500,
    tickSize: parsePrice('0.01'),
    lotSize: parseQuantity('0.00001'),
    minOrderNotional: parsePrice('1.00'),
  },
  {
    symbol: 'vHLX',
    name: 'Helix Biotech',
    description: 'Clinical-stage gene editing platform targeting rare disease.',
    sector: 'Biotechnology',
    initialPrice: parsePrice('180.25'),
    annualDriftBps: 600,
    annualVolBps: 9000,
    tickSize: parsePrice('0.01'),
    lotSize: parseQuantity('0.00001'),
    minOrderNotional: parsePrice('1.00'),
  },
  {
    symbol: 'vVAN',
    name: 'Vantage Defense',
    description: 'Autonomous maritime defence systems under long-term contracts.',
    sector: 'Defense',
    initialPrice: parsePrice('310.10'),
    annualDriftBps: 900,
    annualVolBps: 3800,
    tickSize: parsePrice('0.01'),
    lotSize: parseQuantity('0.00001'),
    minOrderNotional: parsePrice('1.00'),
  },
];
