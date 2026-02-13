const axios = require("axios");

async function fetchMarketAuxNews({ limit = 6 } = {}) {
  const r = await axios.get("https://api.marketaux.com/v1/news/all", {
    params: {
      api_token: process.env.MARKETAUX_API_KEY,
      language: "en",
      limit,
    },
    timeout: 15000,
  });
  return r.data?.data || [];
}

async function fetchFinnhubNews({ limit = 6 } = {}) {
  const r = await axios.get("https://finnhub.io/api/v1/news", {
    params: { category: "general", token: process.env.FINNHUB_API_KEY },
    timeout: 15000,
  });
  return (r.data || []).slice(0, limit);
}

function normalizeNews({ marketaux = [], finnhub = [] }) {
  const a = marketaux.map((x) => ({
    source: x.source || "MarketAux",
    title: x.title,
    url: x.url,
    published_at: x.published_at || "",
    summary: x.description || x.snippet || "",
  }));

  const b = finnhub.map((x) => ({
    source: x.source || "Finnhub",
    title: x.headline,
    url: x.url,
    published_at: x.datetime ? new Date(x.datetime * 1000).toISOString() : "",
    summary: x.summary || "",
  }));

  const seen = new Set();
  const merged = [];

  for (const item of [...a, ...b]) {
    const key = item.url || item.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }

  return merged;
}

module.exports = { fetchMarketAuxNews, fetchFinnhubNews, normalizeNews };