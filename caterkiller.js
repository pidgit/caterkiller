#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STRATEGIES = {
  dca: 'Buy on a fixed interval. Simple dollar-cost averaging instead of price-signal chasing.',
  momentum: 'Buy when price is rising. Sell if price falls below the last mark.',
  meanReversion: 'Buy on dips, sell when price is stretched upward.',
  breakout: 'Buy when price breaks above the last local high.',
};

const PLACEHOLDER_DEFAULTS = {
  SOL_PRICE: 0.000001,
  DCA_SOL: 0.01,
  BUY_SOL: 0.01,
};

const LAMPORTS_PER_SOL = 1_000_000_000;
const PRIORITY_FEE_SOL = 0.00005;
const ENV_PATH = path.join(__dirname, '.env');

const ENDPOINTS = {
  coin: 'https://frontend-api-v3.pump.fun/coins-v2/',
  trade: 'https://pumpportal.fun/api/trade?api-key=',
  stream: 'wss://pumpportal.fun/api/data?api-key=',
  solanaRpc: 'https://api.mainnet-beta.solana.com',
  solanaUsd: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
};

const BROWSER_HEADERS = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' };

const RECONNECT_DELAY_MS = 5000;
const STATUS_INTERVAL_MS = 5000;
const HISTORY_LIMIT = 20;
const STATS_WINDOW = 12;
const TRADE_TYPES = ['buy', 'sell'];
const SPOT_POOLS = [undefined, null, 'pump'];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  mint: '',
  strategy: 'dca',
  botRunning: false,
  mode: 'sim',
  liveConfirmationPending: false,
  apiKey: '',
  publicWallet: '',
  currentPrice: null,
  lastPrice: null,
  solanaUsdPrice: null,
  priceHistory: [],
  lastSignalAt: 0,
  lastWsEventAt: 0,
  currentTokenSymbol: '',
  strategyCooldownMs: 10 * 1000,
  dcaIntervalMs: 60 * 1000,
  buyAmountSol: PLACEHOLDER_DEFAULTS.DCA_SOL,
  dcaLastBuyAt: 0,
  pumpPortalApiCalls: 0,
  lastPumpPortalApiCallAt: null,
  eventsReceived: 0,
  apiFeesSol: 0,
  statusRenderThrottleMs: 3000,
  lastStatusRenderAt: 0,
  statusRenderLoop: null,
  rl: null,
  position: {
    tokens: 0,
    totalCostSol: 0,
    averageCostSol: 0,
    realizedPnL: 0,
    closedTrades: 0,
  },
  websocket: null,
  liveStreamReady: false,
  debug: false,
  shuttingDown: false,
  lastSubscribedMint: '',
  sessionEventCount: 0,
};

// ---------------------------------------------------------------------------
// Math and formatting
// ---------------------------------------------------------------------------

const round = (value, precision = 6) => {
  const multiplier = 10 ** precision;
  return Math.round((Number(value) || 0) * multiplier) / multiplier;
};

const percentChange = (from, to) => (from > 0 ? ((to - from) / from) * 100 : 0);

const average = (values) => values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;

const ratio = (numerator, denominator) => {
  const top = Number(numerator);
  const bottom = Number(denominator);
  return Number.isFinite(top) && Number.isFinite(bottom) && top > 0 && bottom > 0 ? top / bottom : null;
};

const share = (total, percent) => total * (percent / 100);

const formatSolAmount = (value, precision = 9) => {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) {
    return 'n/a';
  }

  const formatted = num.toFixed(precision);
  return formatted.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
};

const formatPrice = (value, unit = 'SOL') => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return 'no price';
  }
  return formatSolAmount(num, 9) + ' ' + unit;
};

const formatPercent = (value) => {
  if (!Number.isFinite(value)) return 'n/a';
  const sign = value >= 0 ? '+' : '-';
  return sign + Math.abs(value).toFixed(2) + '%';
};

const formatMoney = (value, options = {}) => {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return 'n/a';

  const minimumFractionDigits = Number.isFinite(options.minimumFractionDigits) ? options.minimumFractionDigits : 2;
  const maximumFractionDigits = Number.isFinite(options.maximumFractionDigits) ? options.maximumFractionDigits : 4;
  const sign = num < 0 ? '-' : '';

  return sign + '$' + new Intl.NumberFormat('en-US', {
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(Math.abs(num));
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const ANSI = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[32m', // Intended as '\x1b[36m'; kept as-is to preserve output.
  magenta: '\x1b[35m',
  brightCyan: '\x1b[96m',
};

const colorize = (text, code) => {
  if (!process.stdout || !process.stdout.isTTY || process.env.NO_COLOR) {
    return text;
  }
  return code + text + ANSI.reset;
};

const logInfo = (message) => console.log(colorize(message, ANSI.cyan));
const logSuccess = (message) => console.log(colorize(message, ANSI.green));
const logError = (message) => console.log(colorize(message, ANSI.red));
const logWarning = (message) => console.log(colorize(message, ANSI.yellow));
const logStatus = (message) => console.log(colorize(message, ANSI.brightCyan));
// Purple API-call trace; tag is 'PF' (Pump.fun) or 'PP' (PumpPortal).
const logApiCall = (tag, message) => console.log(colorize('(' + tag + ') ' + message, ANSI.magenta));

const debugTradeSignal = (message) => {
  if (!state.debug) return;
  console.log('[debug] ' + message);
};

// ---------------------------------------------------------------------------
// .env read and write
// ---------------------------------------------------------------------------

const parseBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return Boolean(value);
};

const isAssignmentLine = (trimmed) => Boolean(trimmed) && !trimmed.startsWith('#') && trimmed.includes('=');

const readEnvLines = () => (fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/) : []);

const loadEnv = () =>
  readEnvLines()
    .map((line) => line.trim())
    .filter(isAssignmentLine)
    .reduce((env, trimmed) => {
      const index = trimmed.indexOf('=');
      return { ...env, [trimmed.slice(0, index).trim()]: trimmed.slice(index + 1).trim() };
    }, {});

const writeEnvValue = (key, value) => {
  const normalizedKey = String(key || '').trim();
  const normalizedValue = String(value == null ? '' : value).trim();

  if (!normalizedKey) {
    return false;
  }

  let updated = false;
  const nextLines = readEnvLines().map((line) => {
    const trimmed = line.trim();
    if (!isAssignmentLine(trimmed)) {
      return line;
    }

    const entryKey = trimmed.slice(0, trimmed.indexOf('=')).trim();
    if (entryKey !== normalizedKey) {
      return line;
    }

    updated = true;
    return normalizedKey + '=' + normalizedValue;
  });

  if (!updated) {
    nextLines.push(normalizedKey + '=' + normalizedValue);
  }

  fs.writeFileSync(ENV_PATH, nextLines.join('\n') + '\n', 'utf8');
  return true;
};

const fillStateFromEnv = () => {
  const env = loadEnv();
  state.strategy = (env.STRATEGY || 'dca').trim().toLowerCase();

  if (env.MODE) {
    setMode(env.MODE);
  } else if (parseBoolean(env.TRADE || 'false')) {
    state.mode = 'live';
  } else if (parseBoolean(env.SIMULATION ?? 'true')) {
    state.mode = 'sim';
  }

  state.apiKey = (env.PUMP_API_KEY || '').trim();
  state.publicWallet = (env.PUBLIC_WALLET_KEY || '').trim();
  state.mint = (env.MINT || '').trim();
  const eventsReceived = Number(env._EVENTS_RECEIVED || 0);
  state.eventsReceived = Number.isSafeInteger(eventsReceived) && eventsReceived >= 0 ? eventsReceived : 0;
  state.apiFeesSol = Number(env._API_FEES || 0);
  if (!Number.isFinite(state.apiFeesSol) || state.apiFeesSol < 0) {
    state.apiFeesSol = 0;
  }
  state.dcaIntervalMs = Number(env.DCA_INTERVAL_MS || env.DCA_INTERVAL || 60000);
  const buyAmountFromEnv = Number(
    env.BUY_AMOUNT_SOL || env.BUYAMT_SOL || env.BUYAMT || env.DCA_AMOUNT_SOL || env.DCA_AMOUNT || PLACEHOLDER_DEFAULTS.DCA_SOL,
  );
  state.buyAmountSol = buyAmountFromEnv;

  if (!Number.isFinite(state.dcaIntervalMs) || state.dcaIntervalMs <= 0) {
    state.dcaIntervalMs = 60 * 1000;
  }
  if (!Number.isFinite(state.buyAmountSol) || state.buyAmountSol <= 0) {
    state.buyAmountSol = PLACEHOLDER_DEFAULTS.DCA_SOL;
  }
};

// ---------------------------------------------------------------------------
// Pump.fun, PumpPortal and Solana HTTP clients
// ---------------------------------------------------------------------------

const recordPumpPortalCall = () => {
  state.pumpPortalApiCalls += 1;
  state.lastPumpPortalApiCallAt = Date.now();
};

const recordPumpPortalEvent = () => {
  state.eventsReceived += 1;
  try {
    writeEnvValue('_EVENTS_RECEIVED', state.eventsReceived);
  } catch (error) {
    logWarning('Could not save _EVENTS_RECEIVED to .env: ' + String(error.message || error));
  }
};

const fetchCoin = (mint) => {
  logApiCall('PF', 'GET coin | mint=' + mint);
  return fetch(ENDPOINTS.coin + encodeURIComponent(mint), { headers: BROWSER_HEADERS });
};

const fallbackSymbol = (mint) => mint.slice(0, 6).toUpperCase();

const getTokenDisplayNameForMint = async (mint) => {
  if (!mint) {
    return 'none';
  }

  try {
    const response = await fetchCoin(mint);
    if (!response.ok) {
      return fallbackSymbol(mint);
    }

    const payload = await response.json();
    return payload && payload.symbol ? payload.symbol : fallbackSymbol(mint);
  } catch (error) {
    return fallbackSymbol(mint);
  }
};

const getTokenDisplayName = () => getTokenDisplayNameForMint(state.mint);

const getMarketCap = async () => {
  if (!state.mint) {
    console.log('Set a mint first with <MINT> or `mint <address>`');
    return null;
  }

  try {
    recordPumpPortalCall();
    const response = await fetchCoin(state.mint);

    if (response.status === 429) {
      console.log('Pump.fun rate limited the MCAP lookup. Try again in a moment.');
      return null;
    }

    if (!response.ok) {
      console.log('MCAP unavailable for mint ' + state.mint + ' (HTTP ' + response.status + ').');
      return null;
    }

    const token = await response.json();
    const value = Number(token && (token.market_cap_usd ?? token.usd_market_cap ?? token.market_cap ?? token.market_cap_quote));

    if (!Number.isFinite(value)) {
      console.log('MCAP unavailable for mint ' + state.mint + '.');
      return null;
    }

    console.log('MCAP: ' + formatMoney(value) + ' | mint=' + state.mint);
    return value;
  } catch (error) {
    console.log('MCAP lookup failed: ' + String(error.message || error));
    return null;
  }
};

const tradeRequest = async (action, mint, amount, denominatedInSol, slippage = 10) => {
  if (!state.apiKey) {
    console.log('Missing PUMP_API_KEY in .env');
    return null;
  }

  const body = {
    action,
    mint,
    amount,
    denominatedInSol: String(denominatedInSol),
    slippage,
    priorityFee: PRIORITY_FEE_SOL,
    pool: 'pump',
    skipPreflight: false,
  };

  recordPumpPortalCall();
  logApiCall('PP', 'POST trade | ' + action + ' ' + amount + ' | mint=' + mint);
  const res = await fetch(ENDPOINTS.trade + encodeURIComponent(state.apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log('PumpPortal error: ' + JSON.stringify(json));
    return null;
  }

  if (json && json.signature) {
    state.apiFeesSol += PRIORITY_FEE_SOL;
    writeEnvValue('_API_FEES', state.apiFeesSol.toFixed(9));
  }

  return json;
};

const ensureSolanaUsdPrice = async () => {
  if (Number.isFinite(state.solanaUsdPrice) && state.solanaUsdPrice > 0) {
    return state.solanaUsdPrice;
  }

  try {
    const response = await fetch(ENDPOINTS.solanaUsd);
    if (!response.ok) {
      state.solanaUsdPrice = 0;
      return 0;
    }

    const json = await response.json();
    const value = Number(json && json.solana && json.solana.usd);
    state.solanaUsdPrice = Number.isFinite(value) && value > 0 ? value : 0;
    return state.solanaUsdPrice;
  } catch (error) {
    state.solanaUsdPrice = 0;
    return 0;
  }
};

const getWalletBalance = async () => {
  if (!state.publicWallet) {
    console.log('Missing PUBLIC_WALLET_KEY in .env');
    return null;
  }

  try {
    const rpcResponse = await fetch(ENDPOINTS.solanaRpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBalance',
        params: [state.publicWallet],
      }),
    });

    const json = await rpcResponse.json();
    if (!json || json.error) {
      console.log('RPC balance error: ' + JSON.stringify(json && json.error ? json.error : json));
      return null;
    }

    const lamports = Number(json.result && json.result.value);
    if (!Number.isFinite(lamports)) {
      console.log('Balance unavailable.');
      return null;
    }

    const sol = lamports / LAMPORTS_PER_SOL;
    console.log('Wallet balance: ' + sol.toFixed(6) + ' SOL');
    return sol;
  } catch (error) {
    console.log('Balance lookup failed: ' + String(error.message || error));
    return null;
  }
};

// ---------------------------------------------------------------------------
// Token symbol
// ---------------------------------------------------------------------------

const getCurrentTokenSymbol = () => {
  if (state.currentTokenSymbol) {
    return state.currentTokenSymbol.toUpperCase();
  }
  if (state.mint) {
    return state.mint.slice(0, 4).toUpperCase();
  }
  return 'NONE';
};

const refreshCurrentTokenSymbol = async () => {
  if (!state.mint) {
    state.currentTokenSymbol = '';
    return;
  }

  const symbol = await getTokenDisplayNameForMint(state.mint);
  if (symbol) {
    state.currentTokenSymbol = symbol;
  }
};

// ---------------------------------------------------------------------------
// Price extraction, history and positions
// ---------------------------------------------------------------------------

// Bonding-curve reserves describe the pump pool only. Other pools (e.g. LetsBonk's
// solInPool/tokensInPool) use different fields, so they fall back to the trade's own price.
const extractTradePrice = (payload, mint) => {
  if (!payload || typeof payload !== 'object' || payload.mint !== mint) return 0;

  const execution = ratio(payload.solAmount, payload.tokenAmount);
  if (!SPOT_POOLS.includes(payload.pool)) return execution ?? 0;

  const spot = ratio(payload.vSolInBondingCurve, payload.vTokensInBondingCurve);
  return spot ?? execution ?? 0;
};

const recordPriceSample = (value) => {
  if (!Number.isFinite(value) || value <= 0) {
    return;
  }

  state.priceHistory.push(Number(value));
  if (state.priceHistory.length > HISTORY_LIMIT) {
    state.priceHistory.shift();
  }
};

const getRecentPriceStats = () => {
  const prices = state.priceHistory.slice(-STATS_WINDOW);
  if (prices.length < 2) {
    const current = state.currentPrice || 0;
    return { avg: current, last: current, high: current, low: current, changePct: 0 };
  }

  const first = prices[0];
  const last = prices[prices.length - 1];

  return {
    avg: average(prices),
    last,
    high: Math.max(...prices),
    low: Math.min(...prices),
    changePct: percentChange(first, last),
  };
};

const applyBuy = (position, solAmount, tokenQty) => {
  const tokens = position.tokens + (Number(tokenQty) || 0);
  const totalCostSol = position.totalCostSol + (Number(solAmount) || 0);

  return {
    ...position,
    tokens,
    totalCostSol,
    averageCostSol: tokens > 0 ? totalCostSol / tokens : 0,
    closedTrades: position.closedTrades + 1,
  };
};

const applySell = (position, tokenQty, pricePerToken) => {
  const sold = Math.min(Number(tokenQty) || 0, position.tokens);
  const value = Number(pricePerToken) * sold;
  const costBasis = position.averageCostSol * sold;
  const tokens = Math.max(0, position.tokens - sold);

  return {
    ...position,
    realizedPnL: position.realizedPnL + (value - costBasis),
    tokens,
    totalCostSol: tokens > 0 ? position.averageCostSol * tokens : 0,
    closedTrades: position.closedTrades + 1,
  };
};

const unrealizedPnl = (position, currentPrice) => {
  if (!position.tokens || !Number.isFinite(Number(currentPrice))) {
    return 0;
  }

  return Number(currentPrice) * position.tokens - position.totalCostSol;
};

const totalPnlSol = (position, currentPrice) =>
  Number((position.realizedPnL || 0) + (unrealizedPnl(position, currentPrice) || 0));

const positionPerformance = (position, currentPrice) => {
  const costBasis = Number(position.totalCostSol || 0);
  if (!Number.isFinite(costBasis) || costBasis <= 0) {
    return { pct: null, multiple: null };
  }

  const value = Number(currentPrice || 0) * Number(position.tokens || 0);
  const pct = ((value - costBasis) / costBasis) * 100;
  const multiple = value / costBasis;

  return {
    pct: Number.isFinite(pct) ? pct : null,
    multiple: Number.isFinite(multiple) ? multiple : null,
  };
};

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

const SCORERS = {
  momentum: (last, prev, stats) => percentChange(prev, last) * 2 + percentChange(stats.avg, last),
  meanReversion: (last, prev, stats) => -percentChange(stats.avg, last),
  breakout: (last, prev, stats) => percentChange(stats.high, last) * 10,
};

// Each rule is [predicate, signal], checked in order.
const RULES = {
  momentum: [
    [(score) => score >= 0.5, 'buy'],
    [(score) => score <= -0.5, 'sell'],
  ],
  meanReversion: [
    [(score) => score >= 0.8, 'sell'],
    [(score) => score <= -0.8, 'buy'],
  ],
  breakout: [
    [(score) => score >= 1, 'buy'],
    [(score) => score <= -1, 'sell'],
  ],
};

const lookup = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

const getSignalScore = () => {
  if (!state.currentPrice) {
    return 0;
  }

  const stats = getRecentPriceStats();
  const last = Number(state.currentPrice || 0);
  const prev = Number(state.lastPrice || stats.last || last);
  const scorer = lookup(SCORERS, state.strategy);

  return scorer ? scorer(last, prev, stats) : 0;
};

const signalFor = (strategy, score) => {
  const rules = lookup(RULES, strategy);
  const match = rules && rules.find(([test]) => test(score));
  return match ? match[1] : null;
};

const evaluateDca = () => {
  const knownPrice = Number(state.currentPrice || state.lastPrice || 0);
  if (!Number.isFinite(knownPrice) || knownPrice <= 0) {
    return null;
  }

  const now = Date.now();
  if (!state.dcaLastBuyAt || now - state.dcaLastBuyAt >= state.dcaIntervalMs) {
    state.dcaLastBuyAt = now;
    return 'buy';
  }

  return null;
};

const evaluateScored = () => {
  if (!state.currentPrice) {
    return null;
  }

  recordPriceSample(state.currentPrice);

  const score = getSignalScore();
  const now = Date.now();
  if (state.lastSignalAt && now - state.lastSignalAt < state.strategyCooldownMs) {
    return null;
  }

  const signal = signalFor(state.strategy, score);
  if (signal) {
    state.lastSignalAt = now;
  }
  return signal;
};

const evaluateSignal = () => (state.strategy === 'dca' ? evaluateDca() : evaluateScored());

// ---------------------------------------------------------------------------
// Trade execution and auto trading
// ---------------------------------------------------------------------------

const requireMint = () => {
  if (!state.mint) {
    console.log('Set a mint first with <MINT> or `mint <address>`');
    return false;
  }
  return true;
};

const buy = async (solAmount) => {
  if (!requireMint()) return;

  const amount = Number(solAmount) || PLACEHOLDER_DEFAULTS.BUY_SOL;
  const quotePrice = state.currentPrice || PLACEHOLDER_DEFAULTS.SOL_PRICE;
  const tokens = amount / quotePrice;

  if (state.mode !== 'live') {
    console.log('Simulation buy: ' + amount + ' SOL on mint ' + state.mint);
    state.position = applyBuy(state.position, amount, tokens);
    state.currentPrice = state.currentPrice || quotePrice;
    console.log('  cost basis: ' + formatPrice(state.position.averageCostSol, 'SOL/token'));
    console.log('  PnL now: ' + formatSolAmount(unrealizedPnl(state.position, state.currentPrice), 9) + ' SOL');
    return { fake: true };
  }

  console.log('Real buy: ' + amount + ' SOL on mint ' + state.mint);
  const result = await tradeRequest('buy', state.mint, amount, true, 10);
  if (result && result.signature) {
    state.position = applyBuy(state.position, amount, tokens);
  }
  return result;
};

const sell = async (sellPercent = 100) => {
  if (!requireMint()) return;

  const percent = Math.min(Number(String(sellPercent).replace(/%$/, '')) || 100, 100);
  const targetTokens = share(state.position.tokens || 0, percent);
  const price = state.currentPrice || state.position.averageCostSol || PLACEHOLDER_DEFAULTS.SOL_PRICE;

  if (state.mode !== 'live') {
    console.log('Simulation sell: ' + percent + '% of current mint position');
    state.position = applySell(state.position, targetTokens, price);
    console.log('  remaining tokens: ' + round(state.position.tokens, 6));
    console.log('  realized PnL: ' + round(state.position.realizedPnL, 6) + ' SOL');
    return { fake: true };
  }

  console.log('Real sell: ' + percent + '% of current mint position');
  const result = await tradeRequest('sell', state.mint, percent + '%', false, 10);
  if (result && result.signature) {
    state.position = applySell(state.position, targetTokens, price);
  }
  return result;
};

const priceLabel = (value) => (value != null ? value : 'n/a');

const logStrategyAction = (action, amount) => {
  let readableAmount = 'configured amount';
  if (Number.isFinite(Number(amount))) {
    readableAmount = action === 'sell' ? Number(amount) + '% of position' : Number(amount).toFixed(6) + ' SOL';
  }
  const summary = '[strategy] ' + state.strategy + ' -> ' + action.toUpperCase() + ' ' + readableAmount;
  debugTradeSignal(summary + ' | price=' + priceLabel(state.currentPrice) + ' | last=' + priceLabel(state.lastPrice));
  console.log(summary);
};

const maybeAutoTrade = async () => {
  if (!state.botRunning || !state.mint) {
    return;
  }

  const knownPrice = Number(state.currentPrice || state.lastPrice || 0);
  if (!Number.isFinite(knownPrice) || knownPrice <= 0) {
    return;
  }

  const signal = evaluateSignal();
  if (!signal) {
    debugTradeSignal('signal rejected: strategy=' + state.strategy + ' | price=' + priceLabel(state.currentPrice) + ' | last=' + priceLabel(state.lastPrice));
    return;
  }

  debugTradeSignal('trade signal accepted: strategy=' + state.strategy + ' | signal=' + signal + ' | price=' + priceLabel(state.currentPrice));

  if (signal === 'buy') {
    const amount = Number.isFinite(state.buyAmountSol) && state.buyAmountSol > 0 ? state.buyAmountSol : PLACEHOLDER_DEFAULTS.BUY_SOL;
    logStrategyAction('buy', amount);
    await buy(amount);
  }

  if (signal === 'sell' && state.position.tokens > 0) {
    logStrategyAction('sell', 100);
    await sell(100);
  }
};

// ---------------------------------------------------------------------------
// Prompt, mode and strategy selection
// ---------------------------------------------------------------------------

const resetPromptPrefix = () => {
  if (!state.rl) {
    return;
  }
  state.rl.setPrompt('caterkiller (' + (state.mode === 'sim' ? 'simulation' : 'live') + ' / ' + state.strategy + ' / ' + (state.botRunning ? 'running' : 'stopped') + ')> ');
};

const promptForLiveConfirmation = () => {
  if (state.rl) {
    state.rl.setPrompt('type arm to go live> ');
  }
};

const LIVE_ALIASES = ['live', 'real'];
const SIM_ALIASES = ['sim', 'simulation', 'dry', 'dry-run'];

const normalizeMode = (raw) => {
  const value = String(raw || '').trim().toLowerCase();
  if (LIVE_ALIASES.includes(value)) return 'live';
  if (SIM_ALIASES.includes(value)) return 'sim';
  return null;
};

const setMode = (mode) => {
  const next = normalizeMode(mode);
  if (!next) {
    logError('Usage: live on|off');
    return;
  }

  if (next === 'live') {
    // Stays in sim until `arm` is typed; see handleLiveConfirmation.
    state.mode = 'sim';
    state.liveConfirmationPending = true;
    promptForLiveConfirmation();
    logWarning('Going live. Type `arm` to confirm.');
    return;
  }

  state.mode = 'sim';
  state.liveConfirmationPending = false;
  resetPromptPrefix();
  logSuccess('Mode set to: sim');
};

const handleLiveConfirmation = (input) => {
  if (input.toUpperCase() === 'ARM') {
    state.mode = 'live';
    state.liveConfirmationPending = false;
    resetPromptPrefix();
    logSuccess('Mode set to: live');
    return;
  }

  state.liveConfirmationPending = false;
  resetPromptPrefix();
  logError('You did not type `arm`.');
};

const isKnownStrategy = (key) => Object.hasOwn(STRATEGIES, key);

const strategyNames = () => Object.keys(STRATEGIES).join(', ');

const describeStrategy = (key) => (isKnownStrategy(key) ? STRATEGIES[key] : 'Custom strategy');

const setStrategy = (name) => {
  const key = String(name || '').trim().toLowerCase();
  if (!key || !isKnownStrategy(key)) {
    logError('Unknown strategy. Available: ' + strategyNames());
    return;
  }

  state.strategy = key;
  writeEnvValue('STRATEGY', key);
  if (key === 'dca') {
    state.dcaLastBuyAt = 0;
  }
  resetPromptPrefix();
  logInfo('Strategy set to: ' + key);
};

const startStrategy = (name) => {
  const key = String(name || '').trim().toLowerCase() || state.strategy;
  if (!isKnownStrategy(key)) {
    logError('Unknown strategy. Available: ' + strategyNames());
    return;
  }

  if (state.botRunning) {
    logWarning('Bot already running.');
    return;
  }

  state.strategy = key;
  state.botRunning = true;
  if (key === 'dca') {
    state.dcaLastBuyAt = 0;
  }
  resetPromptPrefix();
  logSuccess('Bot started.');
};

const stopStrategy = () => {
  if (!state.botRunning) {
    logWarning('Nothing to stop, not running.');
    return;
  }

  state.botRunning = false;
  resetPromptPrefix();
  logInfo('Bot stopped.');
};

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------

const row = (label, value) => console.log('  ' + (label + ':').padEnd(19) + value);

const isInputPending = () => Boolean(state.rl && typeof state.rl.line === 'string' && state.rl.line.length > 0);

const lastApiCallLabel = () => (state.lastPumpPortalApiCallAt ? new Date(state.lastPumpPortalApiCallAt).toISOString() : 'never');

const intervalLabel = () => (state.strategy === 'dca' ? (state.dcaIntervalMs / 1000) + 's' : 'n/a');

const buyAmountLabel = () => (Number.isFinite(state.buyAmountSol) && state.buyAmountSol > 0 ? state.buyAmountSol + ' SOL' : 'n/a');

const getProfitUsd = () => {
  const pnlSol = totalPnlSol(state.position, state.currentPrice);
  if (!Number.isFinite(pnlSol)) {
    return null;
  }

  if (!Number.isFinite(state.solanaUsdPrice) || state.solanaUsdPrice <= 0) {
    return null;
  }

  return pnlSol * state.solanaUsdPrice;
};

const renderStatusBanner = (force = false) => {
  if (state.liveConfirmationPending || isInputPending()) {
    return;
  }

  const now = Date.now();
  if (!force && now - state.lastStatusRenderAt < state.statusRenderThrottleMs) {
    return;
  }

  const ageText = state.lastWsEventAt
    ? ((Date.now() - state.lastWsEventAt) < 1000
      ? '<1s ago'
      : (Math.max(0, (Date.now() - state.lastWsEventAt) / 1000)).toFixed(1) + 's ago')
    : 'never';

  logStatus(
    '(TICK) Trading ' + getCurrentTokenSymbol() + ' | ' + formatPrice(state.currentPrice, 'SOL') +
      ' | last event received: ' + ageText + ' | trade events: ' + state.sessionEventCount,
  );
  state.lastStatusRenderAt = now;
};

const startStatusRenderLoop = () => {
  if (state.statusRenderLoop) {
    return;
  }

  state.statusRenderLoop = setInterval(() => {
    if (state.liveConfirmationPending || !state.liveStreamReady || !state.mint || isInputPending()) {
      return;
    }
    renderStatusBanner();
  }, STATUS_INTERVAL_MS);
};

const stopStatusRenderLoop = () => {
  if (state.statusRenderLoop) {
    clearInterval(state.statusRenderLoop);
    state.statusRenderLoop = null;
  }
};

const showStatus = async () => {
  await ensureSolanaUsdPrice();
  const profitUsd = getProfitUsd();
  const tokenName = await getTokenDisplayName();
  const stats = getRecentPriceStats();
  const performance = positionPerformance(state.position, state.currentPrice);
  const { position } = state;

  console.log('\nStatus dump:');
  row('bot running', state.botRunning ? 'yes' : 'no');
  row('mode', state.mode === 'sim' ? 'simulation' : 'live');
  row('feed', state.liveStreamReady ? 'connected' : 'idle');
  row('mint', state.mint || '<none>');
  row('price calls', state.pumpPortalApiCalls);
  row('last api call', lastApiCallLabel());
  row('API fees', formatSolAmount(state.apiFeesSol, 9) + ' SOL (_API_FEES)');
  row('api key', state.apiKey ? 'loaded' : 'missing');
  row('wallet key', state.publicWallet ? 'loaded' : 'missing');
  row('strategy', state.strategy);
  row('strategy info', describeStrategy(state.strategy));
  row('interval', intervalLabel());
  row('buy amount', buyAmountLabel());
  row('price trend', stats.changePct.toFixed(3) + '%');
  row('price avg', formatPrice(stats.avg, 'SOL'));
  row('last price', formatPrice(state.currentPrice, 'SOL'));
  row('avg cost basis', formatPrice(position.averageCostSol, 'SOL/token'));
  row('tokens', formatSolAmount(position.tokens, 9) + ' ' + tokenName);
  row('total cost', formatSolAmount(position.totalCostSol, 9) + ' SOL');
  row('realized PnL', formatSolAmount(position.realizedPnL, 9) + ' SOL');
  row('unrealized PnL', formatSolAmount(unrealizedPnl(position, state.currentPrice), 9) + ' SOL');
  row('unrealized gain', performance.pct === null || performance.multiple === null ? 'n/a' : formatPercent(performance.pct) + ' / ' + performance.multiple.toFixed(2) + 'x');
  console.log('  -------------------');
  row('profit', profitUsd === null ? 'n/a' : formatMoney(profitUsd) + ' USD');
  row('holdings', position.tokens > 0 ? formatMoney((position.tokens * Number(state.currentPrice || 0)) * state.solanaUsdPrice) + ' USD' : '$0.00 USD');
};

// ---------------------------------------------------------------------------
// Help and banner
// ---------------------------------------------------------------------------

const HELP_LINES = [
  '  <MINT>              Set the current mint address',
  '  live                Toggle live mode on/off',
  '  buy [SOL]           Buy the current mint using SOL amount',
  '  buyamt [SOL]        Set the strategy buy amount (used by DCA / auto buys)',
  '  sell [PERCENT]      Sell 100% of the current mint position',
  '  wallet              Show the current SOL balance for the configured wallet',
  '  mcap                Show the current mint market cap from PumpPortal/Pump.fun',
  '  pos                 Show current position, bot state, and account snapshot',
  '  strategy [NAME]     Set the active strategy',
  '  debug               Toggle verbose trade-signal logging',
  '  start               Start the active strategy',
  '  stop                Stop the active strategy',
  '  help                Show this help section',
  '  exit                Quit Caterkiller',
];

const printHelp = () => {
  console.log('\nCommands:');
  HELP_LINES.forEach((line) => console.log(line));
};

const banner = () => {
  console.log('========================================');
  console.log('Caterkiller  v0.1');
  console.log('Minimal Pump.fun trading bot');
  console.log('========================================');
};

// ---------------------------------------------------------------------------
// PumpPortal realtime stream
// ---------------------------------------------------------------------------

// onerror and onclose both fire for one failure, so reconnects are tracked in a single slot.
let reconnectTimer = null;

// Socket calls can race with closing sockets; a failed send just leaves state unchanged.
const attempt = (fn) => {
  try {
    fn();
    return true;
  } catch (error) {
    return false;
  }
};

const syncMintSubscription = () => {
  const socket = state.websocket;
  if (!socket || socket.readyState !== 1) {
    return;
  }

  const currentMint = String(state.mint || '').trim();
  if (!currentMint) {
    return;
  }

  const send = (message) => attempt(() => socket.send(JSON.stringify(message)));

  if (state.lastSubscribedMint && state.lastSubscribedMint !== currentMint) {
    send({ method: 'unsubscribeTokenTrade', keys: [state.lastSubscribedMint] });
  }

  if (state.lastSubscribedMint !== currentMint && send({ method: 'subscribeTokenTrade', keys: [currentMint] })) {
    state.lastSubscribedMint = currentMint;
  }
};

const cleanupRealtimeSocket = () => {
  if (!state.websocket || state.shuttingDown) {
    return;
  }

  state.shuttingDown = true;
  console.log('Tearing down PumpPortal websocket connection cleanly...');

  attempt(() => {
    if (state.mint && state.websocket.readyState === 1) {
      state.websocket.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [state.mint] }));
      console.log('Unsubscribed from mint:', state.mint);
    }
  });

  attempt(() => {
    if (state.websocket.readyState === 1) {
      state.websocket.close();
      console.log('PumpPortal websocket closed.');
    }
  });
};

const scheduleReconnect = () => {
  if (reconnectTimer || state.shuttingDown) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!state.shuttingDown) {
      connectRealtime();
    }
  }, RECONNECT_DELAY_MS);
};

const isTradeEvent = (payload) => Boolean(payload && payload.mint && TRADE_TYPES.includes(payload.txType));

// Subscription acks and server errors carry only a message; surface them so refusals are not silent.
const reportServerMessage = (payload) => {
  const text = payload && (payload.message || payload.error || payload.errors);
  logWarning('PumpPortal: ' + (typeof text === 'string' ? text : JSON.stringify(payload)));
};

const handleStreamMessage = async (event) => {
  try {
    const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
    if (!raw) {
      return;
    }

    console.log('[websocket] raw message:', raw.slice(0, 1500));

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (parseError) {
      console.log('[websocket] parse ignored:', String(parseError && parseError.message ? parseError.message : parseError));
      console.log('[websocket] non-json payload:', raw.slice(0, 1500));
      return;
    }

    if (!isTradeEvent(payload)) {
      reportServerMessage(payload);
      return;
    }

    state.sessionEventCount += 1;
    recordPumpPortalEvent();
    state.lastWsEventAt = Date.now();

    const price = extractTradePrice(payload, state.mint);
    if (!price || price <= 0) {
      console.log('[websocket] event ignored: no usable price in payload | keys=' + Object.keys(payload || {}).slice(0, 10).join(', '));
      return;
    }

    state.lastPrice = Number(state.currentPrice) > 0 ? state.currentPrice : price;
    state.currentPrice = price;
    console.log('[websocket] price cached: ' + price + ' | keys=' + Object.keys(payload || {}).slice(0, 10).join(', '));
    await maybeAutoTrade();
  } catch (error) {
    console.log('[websocket] handler error:', String(error && error.message ? error.message : error));
  }
};

const connectRealtime = async () => {
  if (!state.apiKey) {
    console.log('Live stream disabled: missing PUMP_API_KEY in .env');
    return null;
  }

  if (state.shuttingDown) {
    return null;
  }

  // PumpPortal allows one connection; never open a second while one is live or connecting.
  if (state.websocket && state.websocket.readyState <= 1) {
    return state.websocket;
  }

  const WebSocketCtor = globalThis.WebSocket || require('ws');
  const ws = new WebSocketCtor(ENDPOINTS.stream + encodeURIComponent(state.apiKey));
  const isCurrent = () => state.websocket === ws;

  ws.onopen = () => {
    if (!isCurrent()) return;
    state.liveStreamReady = true;
    state.shuttingDown = false;
    // Subscriptions belong to the connection, so a fresh socket always starts with none.
    state.lastSubscribedMint = '';
    startStatusRenderLoop();
    console.log('Connected to PumpPortal realtime stream.');
    if (state.mint) {
      console.log('Subscribing to token trade for mint:', state.mint);
      syncMintSubscription();
    }
  };

  ws.onmessage = (event) => (isCurrent() ? handleStreamMessage(event) : undefined);

  ws.onclose = () => {
    if (!isCurrent()) return;
    state.liveStreamReady = false;
    state.lastSubscribedMint = '';
    stopStatusRenderLoop();
    if (!state.shuttingDown) {
      console.log('PumpPortal stream closed.');
      scheduleReconnect();
    }
  };

  ws.onerror = (error) => {
    if (!isCurrent()) return;
    state.liveStreamReady = false;
    state.lastSubscribedMint = '';
    stopStatusRenderLoop();
    console.log('PumpPortal stream error: ' + String(error && error.message ? error.message : error));
    scheduleReconnect();
  };

  state.websocket = ws;
  return ws;
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const CLOSE = Symbol('close');

const isMintLike = (value) => /^[A-Za-z0-9]{32,44}$/.test(String(value || '').trim());

const is = (...words) => (lower) => words.includes(lower);
const startsWithAny = (...prefixes) => (lower) => prefixes.some((prefix) => lower.startsWith(prefix));

// Everything after the first word, e.g. "buy 0.5" -> "0.5".
const argAfterWord = (input) => input.slice(input.indexOf(' ') + 1).trim();

const toggleDebug = () => {
  state.debug = !state.debug;
  console.log('Verbose trade debug: ' + (state.debug ? 'on' : 'off'));
};

const listStrategies = () => console.log('Available strategies: ' + strategyNames());

const showBuyAmount = () => console.log('Current buy amount: ' + state.buyAmountSol + ' SOL');

const setBuyAmount = (raw) => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logError('Buy amount must be a positive number in SOL.');
    return;
  }

  state.buyAmountSol = parsed;
  state.strategy = state.strategy || 'dca';
  writeEnvValue('BUY_AMOUNT_SOL', parsed);
  console.log('Buy amount set to: ' + parsed + ' SOL');
};

const changeMint = async (nextMint) => {
  if (state.mint && nextMint === state.mint) {
    logWarning('Mint is already set to: ' + state.mint + ' — no change made.');
    return;
  }

  if (state.mint && state.position.tokens > 0) {
    const coinSymbol = await getTokenDisplayNameForMint(state.mint);
    logWarning('Dumping existing holdings of ' + coinSymbol + '...');
    await sell(100);
  }

  state.mint = nextMint;
  state.currentTokenSymbol = '';
  await refreshCurrentTokenSymbol();
  writeEnvValue('MINT', nextMint);
  syncMintSubscription();
  console.log('Current mint set to: ' + state.mint);
};

const commands = [
  { match: is('help'), run: () => printHelp() },
  {
    match: is('exit', 'quit'),
    run: () => {
      console.log('Closing Caterkiller.');
      cleanupRealtimeSocket();
      return CLOSE;
    },
  },
  { match: is('status', 'position', 'pos'), run: () => showStatus() },
  { match: is('wallet'), run: () => getWalletBalance() },
  { match: is('mcap'), run: () => getMarketCap() },
  { match: is('debug'), run: toggleDebug },
  { match: is('strategy', 'strat'), run: listStrategies },
  { match: startsWithAny('strategy ', 'strat '), run: (input) => setStrategy(argAfterWord(input)) },
  { match: is('start'), run: () => startStrategy() },
  { match: is('stop'), run: () => stopStrategy() },
  { match: is('live'), run: () => setMode(state.mode === 'live' ? 'sim' : 'live') },
  { match: is('live on'), run: () => setMode('live') },
  { match: is('live off'), run: () => setMode('sim') },
  { match: is('buy'), run: () => buy(String(PLACEHOLDER_DEFAULTS.BUY_SOL)) },
  { match: is('buyamt'), run: showBuyAmount },
  { match: startsWithAny('buyamt '), run: (input) => setBuyAmount(argAfterWord(input)) },
  {
    match: startsWithAny('buy '),
    run: (input) => buy(argAfterWord(input) || String(PLACEHOLDER_DEFAULTS.BUY_SOL)),
  },
  { match: is('sell'), run: () => sell(100) },
  { match: startsWithAny('sell '), run: (input) => sell(argAfterWord(input) || 100) },
  { match: (lower, input) => isMintLike(input), run: (input) => changeMint(input.trim()) },
  { match: startsWithAny('mint '), run: (input) => changeMint(argAfterWord(input)) },
];

const dispatch = async (input) => {
  const lower = input.toLowerCase();
  const command = commands.find((entry) => entry.match(lower, input));

  if (!command) {
    logWarning('Unknown command. Type `help` for commands.');
    return undefined;
  }

  return command.run(input);
};

// ---------------------------------------------------------------------------
// REPL
// ---------------------------------------------------------------------------

const handleInput = (input) => (state.liveConfirmationPending ? handleLiveConfirmation(input) : dispatch(input));

const startRepl = () => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  state.rl = rl;
  resetPromptPrefix();
  rl.prompt();

  // Serialize lines so a slow command finishes before the next one runs.
  let queue = Promise.resolve();
  let exiting = false;
  let closed = false;

  const step = async (raw) => {
    if (exiting) return;

    const input = String(raw || '').trim();
    const result = input ? await handleInput(input) : undefined;

    if (result === CLOSE) {
      exiting = true;
      rl.close();
      return;
    }

    if (!closed) rl.prompt();
  };

  rl.on('line', (raw) => {
    queue = queue.then(() => step(raw));
  });

  // Stdin can hit EOF before queued lines run, so drain the queue before exiting.
  rl.on('close', () => {
    closed = true;
    queue.finally(() => {
      cleanupRealtimeSocket();
      process.exit(0);
    });
  });
};

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const registerShutdownHooks = () => {
  const shutdown = () => {
    cleanupRealtimeSocket();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('exit', () => cleanupRealtimeSocket());
};

const bootMessage = () => {
  if (state.mint) {
    return 'Booted with mint: ' + state.mint;
  }
  if (state.apiKey || state.publicWallet) {
    return 'Booted with mint: <none>';
  }
  return null;
};

const main = async () => {
  registerShutdownHooks();
  fillStateFromEnv();

  banner();
  printHelp();

  if (state.mint) {
    await refreshCurrentTokenSymbol();
  }

  const boot = bootMessage();
  if (boot) {
    console.log(boot);
  }

  await connectRealtime();
  startRepl();
};

main();
