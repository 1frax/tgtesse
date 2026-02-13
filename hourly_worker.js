require("dotenv").config();
const cron = require("node-cron");
const db = require("./db");
const OpenAI = require("openai");
const axios = require("axios");

const HOURLY_CRON = process.env.HOURLY_CRON || "0 * * * *";
let openai = null;

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

async function fetchNews() {
  if (!process.env.MARKETAUX_API_KEY) {
    console.warn("[WARN] MARKETAUX_API_KEY no configurada. Se omite fetch de noticias.");
    return [];
  }

  const marketaux = await axios.get("https://api.marketaux.com/v1/news/all", {
    params: {
      api_token: process.env.MARKETAUX_API_KEY,
      language: "en",
      limit: 5,
    },
    timeout: 15000,
  });

  return marketaux.data?.data || [];
}

async function generatePulse(news) {
  const client = getOpenAIClient();
  if (!client) {
    return "⚠️ Pulse no disponible temporalmente: falta OPENAI_API_KEY en el entorno.";
  }

  const prompt = `
Create a concise hourly market update in Spanish.
Educational only. No financial advice.
Use a professional style with object emojis only (no faces).

Include:
- TL;DR
- Drivers
- Market regime (risk-on / risk-off / mixed)
- Scenarios
- Checklist

News:
${JSON.stringify(news).slice(0, 8000)}
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: "Educational market assistant in Spanish. Use object emojis only." },
      { role: "user", content: prompt },
    ],
  });

  return resp.choices[0].message.content || "⚠️ No pude generar el pulse.";
}

async function sendPulse(bot) {
  const subs = db.prepare("SELECT chat_id FROM subscribers WHERE is_active=1").all();
  if (!subs.length) return;

  try {
    const news = await fetchNews();
    const pulse = await generatePulse(news);

    for (const s of subs) {
      try {
        await bot.sendMessage(s.chat_id, `⏱️ *Market Pulse*\n\n${pulse}`, {
          parse_mode: "Markdown",
        });
      } catch (e) {
        db.prepare("UPDATE subscribers SET is_active=0 WHERE chat_id=?").run(String(s.chat_id));
      }
    }
  } catch (err) {
    console.error("[ERROR] sendPulse:", err.message);
  }
}

function startHourly(bot) {
  if (!cron.validate(HOURLY_CRON)) {
    console.error("[ERROR] HOURLY_CRON invalido:", HOURLY_CRON);
    return;
  }

  cron.schedule(
    HOURLY_CRON,
    () => {
      sendPulse(bot).catch((err) => console.error("[ERROR] cron pulse:", err.message));
    },
    { timezone: process.env.HOURLY_TZ || "America/Mexico_City" }
  );

  console.log(`[OK] Hourly updates activados con cron '${HOURLY_CRON}'.`);
}

module.exports = { startHourly };
