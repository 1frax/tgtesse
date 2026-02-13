const COMPANY_TO_TICKER = {
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
};

function extractLikelyTicker(text = "") {
  const upper = text.toUpperCase();
  const dollarMatch = upper.match(/\$([A-Z]{1,6})\b/);
  if (dollarMatch) return dollarMatch[1];

  const tokenMatch = upper.match(/\b[A-Z]{2,5}\b/g);
  if (!tokenMatch) return null;

  const blacklist = new Set(["QUE", "CON", "PARA", "HOY", "NEWS", "PULSE", "SPX"]);
  for (const token of tokenMatch) {
    if (!blacklist.has(token)) return token;
  }
  return null;
}

function resolveTickerFromText(text = "") {
  const lower = text.toLowerCase();

  for (const [company, ticker] of Object.entries(COMPANY_TO_TICKER)) {
    if (lower.includes(company)) return ticker;
  }

  return extractLikelyTicker(text);
}

function isOnDemandAnalysisRequest(text = "") {
  const lower = text.toLowerCase();
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

  if (intents.some((x) => lower.includes(x))) return true;
  return !!resolveTickerFromText(text);
}

module.exports = {
  resolveTickerFromText,
  isOnDemandAnalysisRequest,
};
