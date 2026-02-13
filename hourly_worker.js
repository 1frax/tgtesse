require("dotenv").config();
const cron = require("node-cron");
const db = require("./db");
const OpenAI = require("openai");
const axios = require("axios");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function fetchNews() {
  const marketaux = await axios.get("https://api.marketaux.com/v1/news/all", {
    params: {
      api_token: process.env.MARKETAUX_API_KEY,
      language: "en",
      limit: 5,
    }
  });

  return marketaux.data?.data || [];
}

async function generatePulse(news) {
  const prompt = `
Create a concise hourly market update in Spanish.
Educational only. No financial advice.

Include:
- TL;DR
- Drivers
- Market regime (risk-on / risk-off / mixed)
- Scenarios
- Checklist

News:
${JSON.stringify(news).slice(0, 8000)}
`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: "Educational market assistant." },
      { role: "user", content: prompt },
    ],
  });

  return resp.choices[0].message.content;
}

async function sendPulse(bot) {
  const subs = db.prepare(`SELECT chat_id FROM subscribers WHERE is_active=1`).all();
  if (!subs.length) return;

  const news = await fetchNews();
  const pulse = await generatePulse(news);

  for (const s of subs) {
    try {
      await bot.sendMessage(s.chat_id, `🕐 *Market Pulse*\n\n${pulse}`, {
        parse_mode: "Markdown"
      });
    } catch (e) {
      db.prepare(`UPDATE subscribers SET is_active=0 WHERE chat_id=?`)
        .run(String(s.chat_id));
    }
  }
}

function startHourly(bot) {
  cron.schedule("*/2 * * * *", () => {
    sendPulse(bot).catch(console.error);
  }, { timezone: "America/Mexico_City" });

  console.log("⏱️ Hourly updates activados.");
}

module.exports = { startHourly };