import { childLogger } from '../../utils/logger.js';
import { createAbortScope } from '../../utils/abort.js';
import type {
  SearchEngine,
  SearchEngineOptions,
  SearchCategory,
  WebSearchResult,
} from '../types.js';

const log = childLogger('search-engine-crypto');

export interface CryptoEngineConfig {
  enabled?: boolean;
  weight?: number;
  timeoutMs?: number;
}

interface Binance24hrTicker {
  symbol: string;
  lastPrice: string;
  priceChange: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  quoteVolume: string;
}

const COMMON_SYMBOL_MAP: Record<string, string> = {
  bitcoin: 'BTC',
  btc: 'BTC',
  ethereum: 'ETH',
  eth: 'ETH',
  solana: 'SOL',
  sol: 'SOL',
  binance: 'BNB',
  bnb: 'BNB',
  ripple: 'XRP',
  xrp: 'XRP',
  doge: 'DOGE',
  dogecoin: 'DOGE',
  cardano: 'ADA',
  ada: 'ADA',
  pepe: 'PEPE',
  monero: 'XMR',
  xmr: 'XMR',
  avalanche: 'AVAX',
  avax: 'AVAX',
  sui: 'SUI',
};

/**
 * Native Crypto Market Data Engine.
 * Fetches real-time price, 24h change, and volume for cryptocurrencies via public spot endpoints.
 */
export class CryptoEngine implements SearchEngine {
  readonly id = 'crypto';
  readonly name = 'Crypto Market';
  readonly weight: number;
  readonly categories: SearchCategory[] = ['it', 'general'];
  private readonly isEnabled: boolean;
  private readonly timeoutMs: number;

  constructor(cfg: CryptoEngineConfig = {}) {
    this.isEnabled = cfg.enabled ?? true;
    this.weight = cfg.weight ?? 1.9;
    this.timeoutMs = cfg.timeoutMs ?? 4000;
  }

  get enabled(): boolean {
    return this.isEnabled;
  }

  private resolveSymbols(query: string): string[] {
    const tokens = query.toLowerCase().split(/\s+/);
    const symbols = new Set<string>();

    for (const token of tokens) {
      const clean = token.replace(/[^a-z0-9]/g, '');
      if (COMMON_SYMBOL_MAP[clean]) {
        symbols.add(COMMON_SYMBOL_MAP[clean]);
      } else if (
        /^[a-z]{3,5}$/.test(clean) &&
        !['the', 'and', 'for', 'how', 'why', 'who'].includes(clean)
      ) {
        symbols.add(clean.toUpperCase());
      }
    }

    // Default to BTC + ETH + SOL if general crypto query
    if (symbols.size === 0 && /crypto|cripto|mercato|bitcoin|prezzi/i.test(query)) {
      return ['BTC', 'ETH', 'SOL'];
    }

    return [...symbols].slice(0, 3);
  }

  async search(query: string, opts: SearchEngineOptions = {}): Promise<WebSearchResult[]> {
    if (!this.enabled || !query.trim()) return [];
    const symbols = this.resolveSymbols(query);
    if (symbols.length === 0) return [];

    const scope = createAbortScope(this.timeoutMs, opts.signal, 'Crypto Market search');
    const results: WebSearchResult[] = [];

    try {
      const fetches = symbols.map(async (sym) => {
        try {
          const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(sym)}USDT`;
          const res = await fetch(url, {
            signal: scope.signal,
            headers: {
              'User-Agent': 'GoonerBot/2.0 (Crypto Market Tracker)',
              Accept: 'application/json',
            },
          });
          if (!res.ok) return null;
          const data = (await res.json()) as Binance24hrTicker;
          if (!data.lastPrice || !data.symbol) return null;

          const lastPriceNum = parseFloat(data.lastPrice);
          const priceStr =
            lastPriceNum >= 1
              ? lastPriceNum.toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })
              : lastPriceNum.toPrecision(4);

          const changePct = parseFloat(data.priceChangePercent);
          const changeSign = changePct >= 0 ? '+' : '';
          const highStr = parseFloat(data.highPrice).toLocaleString('en-US', {
            maximumFractionDigits: 2,
          });
          const lowStr = parseFloat(data.lowPrice).toLocaleString('en-US', {
            maximumFractionDigits: 2,
          });

          return {
            title: `${sym}/USDT: $${priceStr} (${changeSign}${changePct.toFixed(2)}%)`,
            url: `https://www.binance.com/en/trade/${sym}_USDT`,
            content: `[CRYPTO TICKER] ${sym}/USDT spot price: $${priceStr} | 24h change: ${changeSign}${changePct.toFixed(2)}% | 24h High: $${highStr} | 24h Low: $${lowStr}`,
            engine: this.id,
          };
        } catch {
          return null;
        }
      });

      const settled = await Promise.all(fetches);
      for (const item of settled) {
        if (item) results.push(item);
      }

      return results;
    } catch (err) {
      log.debug({ err, query }, 'Crypto ticker search failed');
      return [];
    } finally {
      scope.dispose();
    }
  }
}
