require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const OpenAI = require("openai");
const db = require("./db");
const { fetchMarketAuxNews, fetchFinnhubNews, normalizeNews } = require("./news");
const { resolveTickerFromText, isOnDemandAnalysisRequest } = require("./asset_resolver");

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error("[ERROR] FALTA TELEGRAM_BOT_TOKEN");
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.error("[ERROR] FALTA OPENAI_API_KEY");
  process.exit(1);
}

const { startHourly } = require("./hourly_worker");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

console.log("[OK] TESSE AI BOT (Telegram) ONLINE");

const memory = new Map();
const MAX_TURNS = 12;

function getHistory(chatId) {
  return memory.get(chatId) || [];
}

function pushHistory(chatId, role, content) {
  const arr = getHistory(chatId);
  arr.push({ role, content });
  if (arr.length > MAX_TURNS) arr.splice(0, arr.length - MAX_TURNS);
  memory.set(chatId, arr);
}

const NEWS_TTL_MS = 1000 * 60 * 5;
const newsCache = {
  fetchedAt: 0,
  merged: [],
};

async function getMergedNewsCached({ limit = 6 } = {}) {
  const now = Date.now();
  const isFresh = newsCache.merged.length > 0 && now - newsCache.fetchedAt < NEWS_TTL_MS;
  if (isFresh) return newsCache.merged.slice(0, limit);

  const [a, b] = await Promise.all([
    fetchMarketAuxNews({ limit: Math.max(limit, 6) }),
    fetchFinnhubNews({ limit: Math.max(limit, 6) }),
  ]);

  const merged = normalizeNews({ marketaux: a, finnhub: b });
  newsCache.merged = merged;
  newsCache.fetchedAt = now;

  return merged.slice(0, limit);
}

async function getTopNewsText() {
  const merged = await getMergedNewsCached({ limit: 6 });
  if (!merged.length) return "No encontre noticias recientes (o la API fallo).";

  const lines = merged.slice(0, 6).map((n, i) => {
    return `${i + 1}) ${n.title}\n   Fuente: ${n.source}\n   Link: ${n.url}`;
  });

  return `📰 *Top noticias recientes*\n\n${lines.join("\n\n")}`;
}

async function analyzeText(chatId, question, { mode = "normal" } = {}) {
  const history = getHistory(chatId);

  let newsContext = "";
  if (mode === "pulse") {
    try {
      const merged = await getMergedNewsCached({ limit: 6 });
      newsContext = merged
        .slice(0, 6)
        .map((n, i) => `${i + 1}) ${n.title} (${n.source})`)
        .join("\n");
    } catch (e) {
      newsContext = "No news context available (API error/limit).";
    }
  }

  const system = `
Eres TESSE AI: analista de mercados estilo Wall Street, con mentalidad de trader y habilidades de maestro.
Reglas:
- Educativo solamente (sin senales de compra/venta, sin garantias).
- Siempre en espanol.
- Estilo profesional, claro y concreto.
- Usa emojis de objetos para guiar lectura (ej: 📊 🧭 📰 ⚠️ 💵 ⏱️), nunca caras/emojis humanos.
- No satures con emojis: maximo 1 por encabezado o bullet clave.
- No repitas el mismo macro-resumen si el usuario hace follow-up. Avanza la conversacion.
- Si el usuario pregunta "que monitorear / que tradear / que vigilar", responde con watchlist, triggers y escenarios.

Si mode="pulse":
- Enfocate en la proxima 1-4 horas (drivers, watchlist, triggers, riesgos).
- Respuesta compacta y accionable (educativa).
Si mode="normal":
- Responde directo y util, sin relleno.

Formato:
- mode="pulse":
  1) TL;DR
  2) Drivers (3-5 bullets)
  3) Watchlist (3-6 activos/temas)
  4) Triggers/Escenarios (alcista/base/bajista) + invalidacion
  5) Checklist (riesgo, eventos, timeframe)
- mode="normal": respuesta directa y util (sin relleno).
`.trim();

  const user = `
Pregunta del usuario: ${question}
${mode === "pulse" ? `\nNoticias recientes (contexto):\n${newsContext}` : ""}
`.trim();

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages: [{ role: "system", content: system }, ...history, { role: "user", content: user }],
  });

  return response.choices[0].message.content?.trim() || "No pude generar respuesta.";
}

async function analyzeImage(imageUrl, caption = "") {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content:
          "Eres TESSE AI, analista educativo estilo Wall Street. Analiza graficas y explica estructura, niveles, tendencia/rango y escenarios. Usa estilo profesional en espanol con emojis de objetos (sin caras).",
      },
      {
        role: "user",
        content: [
          { type: "text", text: caption || "Analiza esta grafica y dame el contexto." },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
  });

  return response.choices[0].message.content?.trim() || "No pude analizar la imagen.";
}

async function upsertSubscriber(chatId) {
  await db.run(
    `
      INSERT INTO subscribers (chat_id, is_active)
      VALUES ($1, TRUE)
      ON CONFLICT (chat_id) DO UPDATE SET
        is_active = TRUE,
        updated_at = NOW()
    `,
    [String(chatId)]
  );
}

async function setActive(chatId, active) {
  await db.run(
    `
      UPDATE subscribers
      SET is_active = $1,
          updated_at = NOW()
      WHERE chat_id = $2
    `,
    [active, String(chatId)]
  );
}

async function enqueueAnalysisJob(chatId, text) {
  const ticker = resolveTickerFromText(text);
  const row = await db.one(
    `
      INSERT INTO analysis_jobs (chat_id, user_query, ticker, status)
      VALUES ($1, $2, $3, 'pending')
      RETURNING id, ticker
    `,
    [String(chatId), text, ticker]
  );
  return row;
}

async function main() {
  await db.init();

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      "📌 TESSE AI listo.\n\nComandos:\n/news = noticias recientes\n/pulse = pulso (drivers + watchlist + escenarios)\n/subscribe = updates cada hora\n/unsubscribe = parar updates\n\nConsulta on-demand:\n- \"que esta pasando con PayPal\"\n- \"analiza PYPL\"\n\nTambien puedes mandar una grafica 📊"
    );
  });

  bot.onText(/\/analyze(?:\s+(.+))?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const query = (match && match[1] ? String(match[1]).trim() : "").trim();
    if (!query) {
      return bot.sendMessage(chatId, "⚠️ Uso: /analyze <activo o ticker>. Ejemplo: /analyze PayPal");
    }

    try {
      const job = await enqueueAnalysisJob(chatId, query);
      const tickerLabel = job?.ticker ? ` (${job.ticker})` : "";
      bot.sendMessage(
        chatId,
        `🛠️ Solicitud recibida${tickerLabel}. Job #${job.id} en cola.\n⏱️ Estoy levantando análisis de mercado + setup técnico.`
      );
    } catch (err) {
      console.error("[ERROR] /analyze:", err.message);
      bot.sendMessage(chatId, "⚠️ No pude crear el job de análisis.");
    }
  });

  bot.onText(/\/news/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      bot.sendMessage(chatId, "📰 Buscando noticias...");
      const text = await getTopNewsText();
      bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("[ERROR] /news:", e.message);
      bot.sendMessage(chatId, "⚠️ Fallo al traer noticias. Revisa API keys o limites.");
    }
  });

  bot.onText(/\/pulse/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      bot.sendMessage(chatId, "⏱️ Generando Market Pulse (contexto)...");
      pushHistory(chatId, "user", "/pulse");
      const reply = await analyzeText(chatId, "Dame el pulso del mercado y que vale la pena vigilar/tradear.", { mode: "pulse" });
      pushHistory(chatId, "assistant", reply);
      bot.sendMessage(chatId, `📊 *TESSE AI*\n\n${reply}`, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("[ERROR] /pulse:", e.message);
      bot.sendMessage(chatId, "⚠️ No pude generar el pulse.");
    }
  });

  bot.onText(/\/subscribe/, async (msg) => {
    try {
      await upsertSubscriber(msg.chat.id);
      bot.sendMessage(msg.chat.id, "✅ Suscrito. Recibiras updates cada hora.");
    } catch (err) {
      console.error("[ERROR] /subscribe:", err.message);
      bot.sendMessage(msg.chat.id, "⚠️ No pude activar tu suscripcion.");
    }
  });

  bot.onText(/\/unsubscribe/, async (msg) => {
    try {
      await setActive(msg.chat.id, false);
      bot.sendMessage(msg.chat.id, "🛑 Ya no recibiras updates.");
    } catch (err) {
      console.error("[ERROR] /unsubscribe:", err.message);
      bot.sendMessage(msg.chat.id, "⚠️ No pude desactivar tu suscripcion.");
    }
  });

  bot.on("message", async (msg) => {
    try {
      const chatId = msg.chat.id;
      if (msg.photo) return;

      const text = msg.text;
      if (!text || text.startsWith("/")) return;

      const lower = text.toLowerCase().trim();

      if (["hola", "hi", "buenas", "que tal", "hey"].includes(lower)) {
        return bot.sendMessage(
          chatId,
          "🧭 Que quieres hacer?\n\n- Escribe: *noticias* (headlines)\n- Escribe: *pulso* (drivers + watchlist + escenarios)\n- Pregunta por un activo: \"SPX hoy\", \"BTC contexto\"\n- Manda una grafica 📊",
          { parse_mode: "Markdown" }
        );
      }

      if (lower === "noticias" || lower.includes("news")) {
        bot.sendMessage(chatId, "📰 Buscando noticias...");
        const newsText = await getTopNewsText();
        return bot.sendMessage(chatId, newsText, { parse_mode: "Markdown" });
      }

      const wantsPulse =
        lower.includes("pulso") ||
        lower.includes("monitor") ||
        lower.includes("vigilar") ||
        lower.includes("tradear") ||
        lower.includes("operar") ||
        lower.includes("contexto") ||
        lower.includes("interesante");

      if (wantsPulse) {
        bot.sendMessage(chatId, "⏱️ Armando contexto (pulso de mercado)...");
        pushHistory(chatId, "user", text);
        const reply = await analyzeText(chatId, text, { mode: "pulse" });
        pushHistory(chatId, "assistant", reply);
        return bot.sendMessage(chatId, `📊 *TESSE AI*\n\n${reply}`, { parse_mode: "Markdown" });
      }

      if (isOnDemandAnalysisRequest(text)) {
        const job = await enqueueAnalysisJob(chatId, text);
        const tickerLabel = job?.ticker ? ` (${job.ticker})` : "";
        return bot.sendMessage(
          chatId,
          `🛠️ Solicitud recibida${tickerLabel}. Job #${job.id} en cola.\n⏱️ Estoy levantando análisis de mercado + setup técnico.`
        );
      }

      bot.sendMessage(chatId, "⏳ Analizando...");
      pushHistory(chatId, "user", text);
      const reply = await analyzeText(chatId, text, { mode: "normal" });
      pushHistory(chatId, "assistant", reply);
      bot.sendMessage(chatId, `📊 *TESSE AI*\n\n${reply}`, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("[ERROR] texto:", err.message);
    }
  });

  bot.on("photo", async (msg) => {
    try {
      const chatId = msg.chat.id;
      const caption = msg.caption || "";

      const photo = msg.photo[msg.photo.length - 1];
      const fileId = photo.file_id;

      const file = await bot.getFile(fileId);
      const imageUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

      console.log("[INFO] Imagen recibida");
      bot.sendMessage(chatId, "📈 Analizando grafica...");

      const reply = await analyzeImage(imageUrl, caption);
      bot.sendMessage(chatId, `📊 *TESSE AI*\n\n${reply}`, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("[ERROR] imagen:", err.message);
    }
  });

  startHourly(bot);

  const express = require("express");
  const app = express();

  app.get("/", (_, res) => res.status(200).send("OK - TESSE BOT RUNNING"));

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log("Health server on", PORT));

  process.on("SIGTERM", async () => {
    console.log("SIGTERM received. Shutting down...");
    try {
      await bot.stopPolling();
    } catch (e) {}
    try {
      await db.close();
    } catch (e) {}
    process.exit(0);
  });

  bot.on("polling_error", (err) => {
    console.error("polling_error:", err?.message || err);
  });
}

main().catch((err) => {
  console.error("[FATAL] Error iniciando bot:", err.message);
  process.exit(1);
});
