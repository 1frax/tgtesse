module.exports = {
  summarizeArticlePrompt: ({ title, url, content }) => `
Eres un analista estilo Wall Street y maestro.
Resume y estructura el análisis de manera educativa (sin señales de compra/venta).

DEVUELVE EN JSON con estas llaves:
{
  "tldr": "...",
  "thesis": ["...","...","..."],
  "catalysts": ["...","...","..."],
  "risks": ["...","...","..."],
  "tickers": ["..."],
  "score": 0-100
}

Contexto:
- Título: ${title}
- URL: ${url}

Contenido (puede estar truncado):
${content.slice(0, 12000)}
`.trim(),
};