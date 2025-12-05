require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const axios = require('axios');
const fs = require('fs');

// ===== КОНФИГУРАЦИЯ =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

// Инициализация бота
const bot = new Telegraf(BOT_TOKEN);

// ===== Google Sheets API клиент (только через env) =====
const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

const auth = new GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====

// Запись/обновление пользователя в Google Sheets
async function saveUserToSheets(userData) {
  try {
    const { userId, chatId, niche, keywords, country } = userData;
    const now = new Date().toISOString();

    // Проверяем, есть ли уже пользователь
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'users!A:G',
    });

    const rows = response.data.values || [];
    let userRow = -1;

    // Ищем строку с этим user_id
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === String(userId)) {
        userRow = i + 1; // +1 потому что индексация с 1
        break;
      }
    }

    const rowData = [userId, chatId, niche, keywords, country, now, now];

    if (userRow > 0) {
      // Обновляем существующую строку
      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: `users!A${userRow}:G${userRow}`,
        valueInputOption: 'RAW',
        resource: { values: [rowData] },
      });
    } else {
      // Добавляем новую строку
      await sheets.spreadsheets.values.append({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: 'users!A:G',
        valueInputOption: 'RAW',
        resource: { values: [rowData] },
      });
    }

    console.log(`User ${userId} saved to Sheets`);
    return true;
  } catch (error) {
    console.error('Error saving to Sheets:', error);
    return false;
  }
}

// Вызов n8n webhook для отправки первого поста
async function triggerFirstPost(chatId) {
  try {
    await axios.post(N8N_WEBHOOK_URL, { chat_id: chatId });
    console.log(`First post triggered for chat_id ${chatId}`);
  } catch (error) {
    console.error('Error triggering first post:', error.message);
  }
}

// ===== СЦЕНЫ ДИАЛОГА =====

// Шаг 1: Ввод ниши
const nicheStep = new Scenes.BaseScene('niche');
nicheStep.enter((ctx) => {
  ctx.reply(
    'Давайте настроим ваш бот!\n\n' +
    '📝 **Шаг 1 из 3**\n\n' +
    'Опишите вашу нишу и целевую аудиторию максимально конкретно (1–3 предложения).\n\n' +
    'Пример: "Онлайн-школа английского языка для айтишников-релокантов в Германии"',
    { parse_mode: 'Markdown' }
  );
});
nicheStep.on('text', (ctx) => {
  ctx.session.niche = ctx.message.text;
  ctx.scene.enter('keywords');
});

// Шаг 2: Ввод ключевых слов
const keywordsStep = new Scenes.BaseScene('keywords');
keywordsStep.enter((ctx) => {
  ctx.reply(
    '✅ Ниша сохранена!\n\n' +
    '📝 **Шаг 2 из 3**\n\n' +
    'Перечислите ключевые слова и темы, которые важны для вас (через запятую).\n\n' +
    'Пример: "английский язык, IT, релокация, работа за границей, программисты, визы, C4D"',
    { parse_mode: 'Markdown' }
  );
});
keywordsStep.on('text', (ctx) => {
  ctx.session.keywords = ctx.message.text;
  ctx.scene.enter('country');
});

// Шаг 3: Страна аудитории
const countryStep = new Scenes.BaseScene('country');
countryStep.enter((ctx) => {
  ctx.reply(
    '✅ Ключевые слова сохранены!\n\n' +
    '📝 **Шаг 3 из 3**\n\n' +
    'Укажите страну или регион вашей аудитории.\n\n' +
    'Пример: "Россия", "Европа", "Россия и Казахстан"',
    { parse_mode: 'Markdown' }
  );
});
countryStep.on('text', async (ctx) => {
  ctx.session.country = ctx.message.text;

  // Показываем сводку и просим подтверждения
  const summary =
    '✅ Все данные собраны!\n\n' +
    `**Ваша ниша:**\n${ctx.session.niche}\n\n` +
    `**Ключевые слова:**\n${ctx.session.keywords}\n\n` +
    `**Страна/регион:**\n${ctx.session.country}\n\n` +
    'Всё верно?';

  await ctx.reply(summary, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Да, всё верно', callback_data: 'confirm' },
          { text: '❌ Исправить', callback_data: 'restart' },
        ],
      ],
    },
  });
});

// Обработка подтверждения
countryStep.action('confirm', async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const { niche, keywords, country } = ctx.session;

  // Сохраняем в Google Sheets
  const saved = await saveUserToSheets({
    userId,
    chatId,
    niche,
    keywords,
    country,
  });

  if (saved) {
    await ctx.reply(
      '🎉 Отлично! Настройки сохранены.\n\n' +
      'Сейчас я подберу для вас первый инфоповод. Это может занять до 2х минут',
      { parse_mode: 'Markdown' }
    );

    // Вызываем n8n для первого поста
    await triggerFirstPost(chatId);

    await ctx.reply(
      '✅ Готово! \n\n' +
      'Чтобы изменить настройки в любой момент — используйте команду /start снова.',
      { parse_mode: 'Markdown' }
    );
  } else {
    await ctx.reply(
      '⚠️ Произошла ошибка при сохранении настроек. Попробуйте ещё раз через /start'
    );
  }

  ctx.scene.leave();
});

// Обработка "Исправить"
countryStep.action('restart', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Хорошо, начнём заново. Используйте /start');
  ctx.scene.leave();
});

// ===== РЕГИСТРАЦИЯ СЦЕН =====
const stage = new Scenes.Stage([nicheStep, keywordsStep, countryStep]);

bot.use(session());
bot.use(stage.middleware());

// ===== КОМАНДЫ =====

bot.command('start', (ctx) => {
  ctx.scene.enter('niche');
});

bot.command('help', (ctx) => {
  ctx.reply(
    'ℹ️ **Помощь**\n\n' +
    '/start — настроить или изменить параметры бота\n' +
    '/help — показать это сообщение\n\n' +
    'Каждый день вы будете получать один инфоповод, адаптированный под вашу нишу и аудиторию.',
    { parse_mode: 'Markdown' }
  );
});

// ===== ЗАПУСК БОТА =====

if (process.env.NODE_ENV === 'production') {
  // Webhook режим для Render
  const domain = process.env.RENDER_EXTERNAL_URL || `https://your-app.onrender.com`;
  bot.telegram.setWebhook(`${domain}/webhook`);
  
  const express = require('express');
  const app = express();
  app.use(bot.webhookCallback('/webhook'));
  
  app.listen(PORT, () => {
    console.log(`Bot is running on port ${PORT} with webhook`);
  });
} else {
  // Polling режим для локальной разработки
  bot.launch();
  console.log('Bot is running in polling mode');
}

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
