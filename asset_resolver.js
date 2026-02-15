const ASSET_TO_TICKER = {
  paypal: "PYPL",
  apple: "AAPL",
  microsoft: "MSFT",
  tesla: "TSLA",
  nvidia: "NVDA",
  amazon: "AMZN",
  google: "GOOGL",
  meta: "META",
  netflix: "NFLX",
  coinbase: "COIN",
  "mercado libre": "MELI",
  bitcoin: "BTC",
  btc: "BTC",
  ethereum: "ETH",
  eth: "ETH",
  solana: "SOL",
  sol: "SOL",
  dogecoin: "DOGE",
  doge: "DOGE",
  ripple: "XRP",
  xrp: "XRP",
};

const TICKER_BLACKLIST = new Set([
  "QUE",
  "CON",
  "PARA",
  "HOY",
  "NEWS",
  "PULSE",
  "DAME",
  "ANALISIS",
  "ANALIZA",
  "DEL",
  "UNA",
  "POR",
  "PLEASE",
  "WHAT",
  "WITH",
]);

function normalizeText(text = "") {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function extractLikelyTicker(text = "") {
  // Caso explicito: $AAPL, $TSLA, etc.
  const dollarMatch = text.match(/\$([A-Za-z]{1,8})\b/);
  if (dollarMatch) return dollarMatch[1];

  // Solo acepta tokens ya escritos en mayusculas en el mensaje original.
  const tokenMatch = text.match(/\b[A-Z]{2,6}\b/g);
  if (!tokenMatch) return null;

  for (const token of tokenMatch) {
    if (!TICKER_BLACKLIST.has(token)) return token;
  }
  return null;
}

function resolveTickerFromText(text = "") {
  const lower = normalizeText(text);

  for (const [asset, ticker] of Object.entries(ASSET_TO_TICKER)) {
    const normalizedAsset = normalizeText(asset);
    const pattern = new RegExp(`\\b${normalizedAsset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (pattern.test(lower)) return ticker;
  }

  const extracted = extractLikelyTicker(text);
  if (!extracted) return null;

  const up = extracted.toUpperCase();
  if (TICKER_BLACKLIST.has(up)) return null;
  if (up.length < 2) return null;

  // fallback
  return up;
}

function isAssetMention(text = "") {
  const lower = normalizeText(text);
  for (const asset of Object.keys(ASSET_TO_TICKER)) {
    const normalizedAsset = normalizeText(asset);
    const pattern = new RegExp(`\\b${normalizedAsset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (pattern.test(lower)) return true;
  }
  return false;
}

function isOnDemandAnalysisRequest(text = "") {
  const lower = normalizeText(text);
  const intents = [
    "que esta pasando con",
    "qué está pasando con",
    "analiza",
    "setup",
    "soportes",
    "resistencias",
    "que opinas de",
    "contexto de",
  ];

  if (intents.some((x) => lower.includes(normalizeText(x)))) return true;
  if (isAssetMention(text)) return true;
  return !!resolveTickerFromText(text);
}

module.exports = {
  resolveTickerFromText,
  isOnDemandAnalysisRequest,
};
