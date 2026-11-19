import { Bot } from "grammy";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_KEY = process.env.API_KEY; // OpenRouter key

if (!BOT_TOKEN || !API_KEY) {
  console.error("Нужны TELEGRAM_BOT_TOKEN и API_KEY в .env");
  process.exit(1);
}

// Основная модель, затем запасные (по порядку)
const MODELS = (
  process.env.MODELS ||
  "nvidia/nemotron-3-ultra-550b-a55b:free,google/gemma-4-31b-it:free,openrouter/free"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

// Модели, которые понимают изображения (по порядку)
const VISION_MODELS = (
  process.env.VISION_MODELS ||
  "nvidia/nemotron-3.5-super-vl:free,google/gemma-4-31b-it:free,openrouter/free"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "Ты дружелюбный помощник в Telegram. Отвечай кратко и по делу на языке пользователя. " +
  "Строгое правило: никогда не используй слова, которые начинаются на букву «а» (русскую «а» и латинскую «a»), " +
  "ни в каком регистре. Перед отправкой проверь каждое слово и замени такие слова синонимами или перефразируй.";
const MAX_HISTORY = 10; // сообщений на чат (пользователь + бот)
const RETRIES_PER_MODEL = 2;

const bot = new Bot(BOT_TOKEN);
const histories = new Map(); // chatId -> [{role, content}]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function askModel(model, messages) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, max_tokens: 1000 }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const err = new Error(data.error?.message || `HTTP ${res.status}`);
    err.status = data.error?.code || res.status;
    throw err;
  }
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Пустой ответ модели");
  return text;
}

// Перебирает модели; при 429/5xx/пустом ответе — повтор, затем следующая модель
async function ask(messages, models = MODELS) {
  let lastError;
  for (const model of models) {
    for (let attempt = 1; attempt <= RETRIES_PER_MODEL; attempt++) {
      try {
        const text = await askModel(model, messages);
        return { text, model };
      } catch (e) {
        lastError = e;
        console.warn(`[${model}] попытка ${attempt}: ${e.message}`);
        const retryable = e.status === 429 || e.status >= 500 || !e.status;
        if (!retryable) break; // 401/402/400 — смысла повторять нет
        await sleep(1000 * attempt);
      }
    }
  }
  throw lastError;
}

// Telegram ограничивает сообщение 4096 символами
async function replyLong(ctx, text) {
  for (let i = 0; i < text.length; i += 4000) {
    await ctx.reply(text.slice(i, i + 4000));
  }
}

bot.command("start", (ctx) =>
  ctx.reply("Привет! Напиши мне что-нибудь. /reset — очистить историю диалога.")
);

bot.command("reset", (ctx) => {
  histories.delete(ctx.chat.id);
  return ctx.reply("История диалога очищена.");
});

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const history = histories.get(chatId) ?? [];
  history.push({ role: "user", content: ctx.message.text });

  const typing = setInterval(() => ctx.replyWithChatAction("typing").catch(() => {}), 4000);
  ctx.replyWithChatAction("typing").catch(() => {});

  try {
    const { text, model } = await ask([
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
    ]);
    history.push({ role: "assistant", content: text });
    histories.set(chatId, history.slice(-MAX_HISTORY));
    console.log(`chat ${chatId} <- ${model}`);
    await replyLong(ctx, text);
  } catch (e) {
    history.pop(); // не сохраняем вопрос без ответа
    console.error("Все модели недоступны:", e.message);
    await ctx.reply("Сейчас бесплатные модели перегружены. Попробуй ещё раз через минуту.");
  } finally {
    clearInterval(typing);
  }
});

// Скачивает файл из Telegram и превращает в data URL для vision-модели
async function fileToDataUrl(ctx, fileId, mimeFallback = "image/jpeg") {
  const file = await ctx.api.getFile(fileId);
  if (file.file_size && file.file_size > 10 * 1024 * 1024) throw new Error("Файл больше 10 МБ");
  const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error(`Не удалось скачать файл: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = file.file_path.split(".").pop().toLowerCase();
  const mime =
    { png: "image/png", webp: "image/webp", gif: "image/gif", jpg: "image/jpeg", jpeg: "image/jpeg" }[ext] ||
    mimeFallback;
  return `data:${mime};base64,${buf.toString("base64")}`;
}

async function handleImage(ctx, fileId, mime) {
  const chatId = ctx.chat.id;
  const history = histories.get(chatId) ?? [];
  const caption = ctx.message.caption?.trim() || "Опиши, что на этом изображении.";

  const typing = setInterval(() => ctx.replyWithChatAction("typing").catch(() => {}), 4000);
  ctx.replyWithChatAction("typing").catch(() => {});

  try {
    const dataUrl = await fileToDataUrl(ctx, fileId, mime);
    const { text, model } = await ask(
      [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
        {
          role: "user",
          content: [
            { type: "text", text: caption },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      VISION_MODELS
    );
    // В историю кладём только текст, чтобы не хранить base64 и не ломать текстовые модели
    history.push({ role: "user", content: `[Пользователь прислал фото] ${caption}` });
    history.push({ role: "assistant", content: text });
    histories.set(chatId, history.slice(-MAX_HISTORY));
    console.log(`chat ${chatId} <- ${model} (image)`);
    await replyLong(ctx, text);
  } catch (e) {
    console.error("Ошибка обработки изображения:", e.message);
    await ctx.reply("Не получилось разобрать изображение. Попробуй ещё раз через минуту.");
  } finally {
    clearInterval(typing);
  }
}

bot.on("message:photo", (ctx) => {
  const largest = ctx.message.photo.at(-1); // последний элемент — самый большой размер
  return handleImage(ctx, largest.file_id, "image/jpeg");
});

bot.on("message:document", (ctx) => {
  const doc = ctx.message.document;
  if (!doc.mime_type?.startsWith("image/")) return ctx.reply("Я понимаю только текст и изображения.");
  return handleImage(ctx, doc.file_id, doc.mime_type);
});

bot.catch((err) => console.error("Ошибка бота:", err.error?.message || err));

bot.start({
  onStart: (me) => console.log(`Бот @${me.username} запущен. Модели: ${MODELS.join(" → ")}`),
});
