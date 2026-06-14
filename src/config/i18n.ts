/**
 * Localization for GoonerBot.
 *
 * Ports the original TelegramRPBot localizer mechanism (per-chat language, key lookup with
 * `{var}` interpolation, fallback to default language) but rebrands ALL copy to the
 * group-native GoonerBot / Gooners voice. The "⚡ lightning" theme and the old RP/Flagro
 * branding are gone.
 *
 * English is the authoritative, fully-rebranded source of truth. Russian and Spanish are
 * provided for /language parity; copy is functional and on-brand.
 */

export type LanguageMap = Record<string, string>;
export type TranslationMap = Record<string, LanguageMap>;

const GITHUB_URL = 'https://github.com/0xfunboy/Goonerbot';

export const translations: TranslationMap = {
  // ---- command descriptions (shown in the Telegram command menu) ----
  start_description: {
    english: 'Wake GoonerBot up in this chat',
    russian: 'Разбудить GoonerBot в этом чате',
    spanish: 'Despierta a GoonerBot en este chat',
  },
  stop_description: {
    english: 'Put GoonerBot to sleep in this chat',
    russian: 'Усыпить GoonerBot в этом чате',
    spanish: 'Duerme a GoonerBot en este chat',
  },
  reset_description: {
    english: 'Wipe the conversation memory for this chat',
    russian: 'Очистить память разговора в этом чате',
    spanish: 'Borra la memoria de conversación de este chat',
  },
  mode_description: {
    english: 'Pick the mode GoonerBot runs in',
    russian: 'Выбрать режим GoonerBot',
    spanish: 'Elige el modo de GoonerBot',
  },
  addmode_description: {
    english: 'Add a custom mode for this chat',
    russian: 'Добавить свой режим для этого чата',
    spanish: 'Agrega un modo personalizado a este chat',
  },
  deletemode_description: {
    english: 'Delete a mode from this chat',
    russian: 'Удалить режим из этого чата',
    spanish: 'Elimina un modo de este chat',
  },
  introduce_description: {
    english: 'Tell GoonerBot who you are',
    russian: 'Расскажи GoonerBot, кто ты',
    spanish: 'Dile a GoonerBot quién eres',
  },
  fact_description: {
    english: 'Save a fact about a Gooner',
    russian: 'Сохранить факт о пользователе',
    spanish: 'Guarda un dato sobre un Gooner',
  },
  facts_description: {
    english: 'Show stored facts about a Gooner',
    russian: 'Показать сохранённые факты о пользователе',
    spanish: 'Muestra los datos guardados sobre un Gooner',
  },
  clearfacts_description: {
    english: 'Clear facts for a Gooner',
    russian: 'Очистить факты о пользователе',
    spanish: 'Borra los datos de un Gooner',
  },
  usage_description: {
    english: 'Show your usage and limits',
    russian: 'Показать использование и лимиты',
    spanish: 'Muestra tu uso y límites',
  },
  language_description: {
    english: 'Set the chat language',
    russian: 'Установить язык чата',
    spanish: 'Configura el idioma del chat',
  },
  terms_description: {
    english: 'View terms of use and your acceptance state',
    russian: 'Посмотреть условия использования и статус',
    spanish: 'Ver términos de uso y tu estado de aceptación',
  },
  conversationtracker_description: {
    english: 'Toggle conversation tracking',
    russian: 'Включить/выключить отслеживание разговора',
    spanish: 'Activa/desactiva el seguimiento de la conversación',
  },
  autofact_description: {
    english: 'Toggle automatic fact extraction',
    russian: 'Включить/выключить автоизвлечение фактов',
    spanish: 'Activa/desactiva la extracción automática de datos',
  },
  autoengage_description: {
    english: 'Toggle auto-engage (bot jumps in on its own)',
    russian: 'Включить/выключить авто-участие',
    spanish: 'Activa/desactiva la auto-participación',
  },
  ban_description: {
    english: 'Ban a Gooner (admin only)',
    russian: 'Забанить пользователя (только админ)',
    spanish: 'Banea a un Gooner (solo admin)',
  },
  unban_description: {
    english: 'Unban a Gooner (admin only)',
    russian: 'Разбанить пользователя (только админ)',
    spanish: 'Desbanea a un Gooner (solo admin)',
  },
  help_description: {
    english: 'Show what GoonerBot can do',
    russian: 'Показать возможности GoonerBot',
    spanish: 'Muestra lo que GoonerBot puede hacer',
  },
  default_command_description: {
    english: 'A GoonerBot command',
    russian: 'Команда GoonerBot',
    spanish: 'Un comando de GoonerBot',
  },

  // ---- responses ----
  start_done: {
    english: "GoonerBot is awake. Let's cook. 🍳",
    russian: 'GoonerBot проснулся. Погнали. 🍳',
    spanish: 'GoonerBot está despierto. A cocinar. 🍳',
  },
  stop_done: {
    english: 'GoonerBot going dark. Ping me when you need chaos again.',
    russian: 'GoonerBot уходит в тень. Зовите, когда снова понадобится хаос.',
    spanish: 'GoonerBot se apaga. Llámame cuando quieras caos otra vez.',
  },
  reset_done: {
    english: 'Memory wiped. Clean slate, who dis.',
    russian: 'Память очищена. Чистый лист, кто это вообще.',
    spanish: 'Memoria borrada. Borrón y cuenta nueva, ¿quién eres?',
  },
  choose_mode: {
    english: 'Pick a mode:',
    russian: 'Выбери режим:',
    spanish: 'Elige un modo:',
  },
  choose_mode_to_delete: {
    english: 'Which mode should I nuke?',
    russian: 'Какой режим удалить?',
    spanish: '¿Qué modo elimino?',
  },
  mode_set: {
    english: 'Now running in {mode_name}.',
    russian: 'Теперь работаю в режиме {mode_name}.',
    spanish: 'Ahora en modo {mode_name}.',
  },
  mode_added: {
    english: 'Mode {mode_name} locked in.',
    russian: 'Режим {mode_name} добавлен.',
    spanish: 'Modo {mode_name} agregado.',
  },
  mode_deleted: {
    english: 'Mode {mode_name} deleted.',
    russian: 'Режим {mode_name} удалён.',
    spanish: 'Modo {mode_name} eliminado.',
  },
  inappropriate_mode: {
    english: "That mode's a no. Try something that won't get us banned.",
    russian: 'Такой режим — нет. Попробуй что-то поспокойнее.',
    spanish: 'Ese modo no. Prueba con algo que no nos banee.',
  },
  invalid_mode_args: {
    english: 'Usage: /addmode <description>',
    russian: 'Использование: /addmode <описание>',
    spanish: 'Uso: /addmode <descripción>',
  },
  introduction_added: {
    english: 'Noted, {user_handle}. Welcome to the lore.',
    russian: 'Записал, {user_handle}. Добро пожаловать в историю.',
    spanish: 'Anotado, {user_handle}. Bienvenido a la lore.',
  },
  inappropriate_introduction: {
    english: "Can't save that intro. Keep it clean-ish.",
    russian: 'Не могу сохранить такое представление.',
    spanish: 'No puedo guardar esa presentación.',
  },
  invalid_fact_args: {
    english: 'Usage: /fact @handle <the fact>',
    russian: 'Использование: /fact @handle <факт>',
    spanish: 'Uso: /fact @handle <el dato>',
  },
  fact_added: {
    english: 'Fact about {user_handle} saved.',
    russian: 'Факт о {user_handle} сохранён.',
    spanish: 'Dato sobre {user_handle} guardado.',
  },
  inappropriate_fact: {
    english: 'Not saving that one. Keep facts safe and non-creepy.',
    russian: 'Такой факт не сохраню.',
    spanish: 'Ese dato no lo guardo.',
  },
  user_facts: {
    english: 'What I know about {user_handle}:\n- {facts}',
    russian: 'Что я знаю о {user_handle}:\n- {facts}',
    spanish: 'Lo que sé de {user_handle}:\n- {facts}',
  },
  user_facts_empty: {
    english: "I've got nothing on {user_handle} yet.",
    russian: 'Пока ничего нет о {user_handle}.',
    spanish: 'Aún no tengo nada de {user_handle}.',
  },
  facts_cleared: {
    english: 'Facts about {user_handle} wiped.',
    russian: 'Факты о {user_handle} очищены.',
    spanish: 'Datos sobre {user_handle} borrados.',
  },
  clearfacts_forbidden: {
    english: 'Only admins can clear facts about other Gooners.',
    russian: 'Только админы могут очищать чужие факты.',
    spanish: 'Solo los admins pueden borrar datos de otros Gooners.',
  },
  invalid_clearfacts_args: {
    english: 'Usage: /clearfacts [@handle]',
    russian: 'Использование: /clearfacts [@handle]',
    spanish: 'Uso: /clearfacts [@handle]',
  },
  usage_text: {
    english: 'Usage this period: {this_month_usage} / {limit} points.',
    russian: 'Использование за период: {this_month_usage} / {limit} очков.',
    spanish: 'Uso este periodo: {this_month_usage} / {limit} puntos.',
  },
  usage_limit_exceeded: {
    english: '{user_handle}, you hit your usage limit ({usage_limit}). Cool down a bit.',
    russian: '{user_handle}, ты достиг лимита ({usage_limit}). Остынь немного.',
    spanish: '{user_handle}, llegaste a tu límite ({usage_limit}). Relájate un poco.',
  },
  choose_language: {
    english: 'Pick a language:',
    russian: 'Выбери язык:',
    spanish: 'Elige un idioma:',
  },
  language_set: {
    english: 'Language set to {language}.',
    russian: 'Язык установлен: {language}.',
    spanish: 'Idioma configurado: {language}.',
  },
  not_authenticated: {
    english: "You can't do that here.",
    russian: 'Тебе сюда нельзя.',
    spanish: 'No puedes hacer eso aquí.',
  },
  conversation_tracker_turned_on: {
    english: "Conversation tracking ON. I'm listening now.",
    russian: 'Отслеживание разговора ВКЛ. Слушаю.',
    spanish: 'Seguimiento de conversación ACTIVADO. Estoy escuchando.',
  },
  conversation_tracker_turned_off: {
    english: 'Conversation tracking OFF. I only reply when poked.',
    russian: 'Отслеживание разговора ВЫКЛ. Отвечаю только когда зовут.',
    spanish: 'Seguimiento de conversación DESACTIVADO. Solo respondo si me llaman.',
  },
  autoengage_turned_on: {
    english: "Auto-engage ON. I'll jump in when it's worth it.",
    russian: 'Авто-участие ВКЛ. Влезу, когда будет повод.',
    spanish: 'Auto-participación ACTIVADA. Me meteré cuando valga la pena.',
  },
  autoengage_turned_off: {
    english: "Auto-engage OFF. I'll wait to be called.",
    russian: 'Авто-участие ВЫКЛ. Жду, когда позовут.',
    spanish: 'Auto-participación DESACTIVADA. Esperaré a que me llamen.',
  },
  autofact_turned_on: {
    english: "Auto-facts ON. I'll remember the good stuff.",
    russian: 'Авто-факты ВКЛ. Запомню важное.',
    spanish: 'Auto-datos ACTIVADOS. Recordaré lo bueno.',
  },
  autofact_turned_off: {
    english: 'Auto-facts OFF. Manual memory only.',
    russian: 'Авто-факты ВЫКЛ. Только ручная память.',
    spanish: 'Auto-datos DESACTIVADOS. Solo memoria manual.',
  },
  nsfw_description: {
    english: 'NSFW model routing: off | base | smart (admin)',
    russian: 'Режим NSFW-модели: off | base | smart (админ)',
    spanish: 'Enrutado del modelo NSFW: off | base | smart (admin)',
  },
  nsfw_unavailable: {
    english: 'NSFW routing is not configured on this backend (no NSFW model set).',
    russian: 'NSFW-маршрутизация не настроена (модель NSFW не задана).',
    spanish: 'El enrutado NSFW no está configurado (sin modelo NSFW).',
  },
  nsfw_status: {
    english: 'NSFW routing for this chat: {mode}. Use /nsfw off|base|smart.',
    russian: 'NSFW-режим этого чата: {mode}. Используй /nsfw off|base|smart.',
    spanish: 'Enrutado NSFW de este chat: {mode}. Usa /nsfw off|base|smart.',
  },
  nsfw_invalid: {
    english: 'Usage: /nsfw off | base | smart (or on = base).',
    russian: 'Использование: /nsfw off | base | smart (или on = base).',
    spanish: 'Uso: /nsfw off | base | smart (o on = base).',
  },
  nsfw_set_off: {
    english: 'NSFW routing OFF. Always using the default model here.',
    russian: 'NSFW ВЫКЛ. Здесь всегда обычная модель.',
    spanish: 'NSFW DESACTIVADO. Aquí siempre el modelo por defecto.',
  },
  nsfw_set_base: {
    english: 'NSFW routing ON (base). This whole chat uses the uncensored model. 🔞',
    russian: 'NSFW ВКЛ (base). Весь чат использует нецензурную модель. 🔞',
    spanish: 'NSFW ACTIVADO (base). Todo el chat usa el modelo sin censura. 🔞',
  },
  nsfw_set_smart: {
    english:
      'NSFW routing ON (smart). I switch to the uncensored model when the vibe calls for it. 🔞',
    russian: 'NSFW ВКЛ (smart). Переключаюсь на нецензурную модель, когда нужно. 🔞',
    spanish: 'NSFW ACTIVADO (smart). Cambio al modelo sin censura cuando hace falta. 🔞',
  },
  user_banned: {
    english: '{user_handle} banned{ban_suffix}.',
    russian: '{user_handle} забанен{ban_suffix}.',
    spanish: '{user_handle} baneado{ban_suffix}.',
  },
  user_unbanned: {
    english: '{user_handle} unbanned. Behave this time.',
    russian: '{user_handle} разбанен. Веди себя прилично.',
    spanish: '{user_handle} desbaneado. Pórtate bien esta vez.',
  },
  invalid_ban_args: {
    english: 'Usage: /ban @handle [seconds] (or reply to a message with /ban [seconds])',
    russian: 'Использование: /ban @handle [секунды] (или ответом на сообщение)',
    spanish: 'Uso: /ban @handle [segundos] (o responde a un mensaje con /ban [segundos])',
  },
  invalid_unban_args: {
    english: 'Usage: /unban @handle',
    russian: 'Использование: /unban @handle',
    spanish: 'Uso: /unban @handle',
  },
  message_response: {
    english: '{response_text}',
    russian: '{response_text}',
    spanish: '{response_text}',
  },
  streaming_message_response: {
    english: '{response_text}',
    russian: '{response_text}',
    spanish: '{response_text}',
  },
  message_moderation_failed: {
    english: "Yeah, I'm not saying that. ({moderation_reason})",
    russian: 'Не, такое я не скажу. ({moderation_reason})',
    spanish: 'No, eso no lo digo. ({moderation_reason})',
  },
  capability_unavailable: {
    english: "I can't do that right now — {capability} isn't set up on this backend.",
    russian: 'Сейчас не могу — {capability} не настроен на этом бэкенде.',
    spanish: 'No puedo hacer eso ahora — {capability} no está configurado en este backend.',
  },
  generation_failed: {
    english: 'That broke on my end. Try again in a sec.',
    russian: 'Что-то сломалось. Попробуй ещё раз.',
    spanish: 'Algo se rompió de mi lado. Inténtalo de nuevo.',
  },
  terms_accept_button: {
    english: '✅ Accept',
    russian: '✅ Принять',
    spanish: '✅ Aceptar',
  },
  terms_decline_button: {
    english: '❌ Decline',
    russian: '❌ Отклонить',
    spanish: '❌ Rechazar',
  },
  terms_accepted: {
    english: "Terms accepted. You're in. 🤝",
    russian: 'Условия приняты. Ты в деле. 🤝',
    spanish: 'Términos aceptados. Estás dentro. 🤝',
  },
  terms_declined: {
    english: 'Terms declined. Your stored data was cleared. Accept the terms to use GoonerBot.',
    russian: 'Условия отклонены. Твои данные удалены. Прими условия, чтобы пользоваться GoonerBot.',
    spanish:
      'Términos rechazados. Tus datos fueron borrados. Acepta los términos para usar GoonerBot.',
  },
  terms_already_accepted: {
    english: 'You already accepted the terms. All good. 🤝',
    russian: 'Ты уже принял условия. Всё ок. 🤝',
    spanish: 'Ya aceptaste los términos. Todo bien. 🤝',
  },
  invalid_terms_action: {
    english: 'That terms action did not compute. Try /terms again.',
    russian: 'Это действие не сработало. Попробуй /terms снова.',
    spanish: 'Esa acción no funcionó. Intenta /terms de nuevo.',
  },
  terms_text: {
    english: [
      '<strong>📋 GoonerBot Terms of Use</strong>',
      '',
      'By using GoonerBot in this chat you agree that:',
      '',
      '<strong>🔒 Data &amp; Memory</strong>',
      '• <b>Messages</b> may be processed and stored to give context-aware replies and keep group memory.',
      '• <b>Images</b> you send (when GoonerBot is addressed) may be described by AI.',
      '• <b>Voice</b> you send (when GoonerBot is addressed) may be transcribed to text.',
      '• <b>Facts</b> about users/group are stored to keep the lore alive.',
      '• <b>Usage</b> is tracked as points to enforce limits.',
      '',
      '<strong>⚡ Your controls</strong>',
      '• /reset wipes the conversation memory.',
      '• /clearfacts wipes stored facts.',
      '• /stop puts GoonerBot to sleep in this chat.',
      '• Decline and your custom stored data is cleared (terms + ban status are kept for safety).',
      '',
      `<strong>🔗 Open source:</strong> <a href="${GITHUB_URL}">GoonerBot on GitHub</a>`,
    ].join('\n'),
    russian: [
      '<strong>📋 Условия использования GoonerBot</strong>',
      '',
      'Используя GoonerBot в этом чате, ты соглашаешься, что:',
      '',
      '<strong>🔒 Данные и память</strong>',
      '• <b>Сообщения</b> могут обрабатываться и храниться для контекстных ответов и групповой памяти.',
      '• <b>Изображения</b> (когда обращаются к GoonerBot) могут описываться ИИ.',
      '• <b>Голос</b> (когда обращаются к GoonerBot) может транскрибироваться.',
      '• <b>Факты</b> о пользователях/группе хранятся для истории.',
      '• <b>Использование</b> отслеживается в виде очков для лимитов.',
      '',
      '<strong>⚡ Твои возможности</strong>',
      '• /reset очищает память разговора.',
      '• /clearfacts очищает факты.',
      '• /stop усыпляет GoonerBot в этом чате.',
      '• Отказ — твои данные удаляются (условия и статус бана сохраняются).',
      '',
      `<strong>🔗 Открытый код:</strong> <a href="${GITHUB_URL}">GoonerBot на GitHub</a>`,
    ].join('\n'),
    spanish: [
      '<strong>📋 Términos de uso de GoonerBot</strong>',
      '',
      'Al usar GoonerBot en este chat aceptas que:',
      '',
      '<strong>🔒 Datos y memoria</strong>',
      '• Los <b>mensajes</b> pueden procesarse y almacenarse para respuestas con contexto y memoria de grupo.',
      '• Las <b>imágenes</b> que envíes (cuando te diriges a GoonerBot) pueden ser descritas por IA.',
      '• El <b>audio</b> que envíes (cuando te diriges a GoonerBot) puede transcribirse a texto.',
      '• Los <b>datos</b> de usuarios/grupo se guardan para mantener la lore.',
      '• El <b>uso</b> se rastrea como puntos para aplicar límites.',
      '',
      '<strong>⚡ Tus controles</strong>',
      '• /reset borra la memoria de conversación.',
      '• /clearfacts borra los datos guardados.',
      '• /stop duerme a GoonerBot en este chat.',
      '• Si rechazas, tus datos personalizados se borran (términos y estado de baneo se conservan).',
      '',
      `<strong>🔗 Código abierto:</strong> <a href="${GITHUB_URL}">GoonerBot en GitHub</a>`,
    ].join('\n'),
  },
  help_text: {
    english: [
      '<strong>GoonerBot 🤖 — your group gremlin</strong>',
      'A group-native entertainment, roleplay, meme, banter &amp; memory bot for the Gooners.',
      '',
      '<strong>What I do</strong>',
      '• Read the room, remember group &amp; user lore, and jump in when it’s funny or useful.',
      '• Run different <b>modes</b> (default, roast, hype, lorekeeper, chaos, market_degen, meme_recorder).',
      '• Take text, images and voice (when you address me) and reply with text (and images/voice if configured).',
      '',
      '<strong>Commands</strong>',
      '• <em>/start</em> — wake me in this chat',
      '• <em>/stop</em> — put me to sleep',
      '• <em>/reset</em> — wipe conversation memory',
      '• <em>/mode</em> — pick a mode',
      '• <em>/addmode &lt;description&gt;</em> — add a custom mode',
      '• <em>/deletemode</em> — delete a mode',
      '• <em>/introduce &lt;text&gt;</em> — tell me who you are',
      '• <em>/fact @handle &lt;fact&gt;</em> — save a fact about a Gooner',
      '• <em>/facts [@handle]</em> — show stored facts',
      '• <em>/clearfacts [@handle]</em> — clear facts',
      '• <em>/usage</em> — your usage and limits',
      '• <em>/language</em> — set chat language',
      '• <em>/terms</em> — terms of use',
      '• <em>/conversationtracker</em> — toggle passive listening',
      '• <em>/autofact</em> — toggle auto fact extraction',
      '• <em>/autoengage</em> — toggle auto-engage',
      '• <em>/nsfw off|base|smart</em> (admin) — NSFW model routing',
      '• <em>/ban @handle [seconds]</em> (admin) — ban a Gooner',
      '• <em>/unban @handle</em> (admin) — unban a Gooner',
      '• <em>/help</em> — this',
      '',
      `<strong>🔗</strong> <a href="${GITHUB_URL}">GoonerBot on GitHub</a>`,
    ].join('\n'),
    russian: [
      '<strong>GoonerBot 🤖 — гремлин вашей группы</strong>',
      'Развлекательный, ролевой, мем- и память-бот для Gooners.',
      '',
      '<strong>Команды</strong>',
      '• <em>/start</em> — разбудить в этом чате',
      '• <em>/stop</em> — усыпить',
      '• <em>/reset</em> — очистить память',
      '• <em>/mode</em> — выбрать режим',
      '• <em>/addmode &lt;описание&gt;</em> — добавить режим',
      '• <em>/deletemode</em> — удалить режим',
      '• <em>/introduce &lt;текст&gt;</em> — рассказать о себе',
      '• <em>/fact @handle &lt;факт&gt;</em> — сохранить факт',
      '• <em>/facts [@handle]</em> — показать факты',
      '• <em>/clearfacts [@handle]</em> — очистить факты',
      '• <em>/usage</em> — использование и лимиты',
      '• <em>/language</em> — язык чата',
      '• <em>/terms</em> — условия',
      '• <em>/conversationtracker</em> — пассивное слушание',
      '• <em>/autofact</em> — авто-факты',
      '• <em>/autoengage</em> — авто-участие',
      '• <em>/ban @handle [секунды]</em> (админ) — забанить',
      '• <em>/unban @handle</em> (админ) — разбанить',
      '• <em>/help</em> — это',
      '',
      `<strong>🔗</strong> <a href="${GITHUB_URL}">GoonerBot на GitHub</a>`,
    ].join('\n'),
    spanish: [
      '<strong>GoonerBot 🤖 — el gremlin del grupo</strong>',
      'Bot de entretenimiento, roleplay, memes, banter y memoria para los Gooners.',
      '',
      '<strong>Comandos</strong>',
      '• <em>/start</em> — despertarme en este chat',
      '• <em>/stop</em> — dormirme',
      '• <em>/reset</em> — borrar memoria',
      '• <em>/mode</em> — elegir modo',
      '• <em>/addmode &lt;descripción&gt;</em> — agregar modo',
      '• <em>/deletemode</em> — eliminar modo',
      '• <em>/introduce &lt;texto&gt;</em> — preséntate',
      '• <em>/fact @handle &lt;dato&gt;</em> — guardar dato',
      '• <em>/facts [@handle]</em> — mostrar datos',
      '• <em>/clearfacts [@handle]</em> — borrar datos',
      '• <em>/usage</em> — uso y límites',
      '• <em>/language</em> — idioma del chat',
      '• <em>/terms</em> — términos',
      '• <em>/conversationtracker</em> — escucha pasiva',
      '• <em>/autofact</em> — auto-datos',
      '• <em>/autoengage</em> — auto-participación',
      '• <em>/ban @handle [segundos]</em> (admin) — banear',
      '• <em>/unban @handle</em> (admin) — desbanear',
      '• <em>/help</em> — esto',
      '',
      `<strong>🔗</strong> <a href="${GITHUB_URL}">GoonerBot en GitHub</a>`,
    ].join('\n'),
  },
};

/**
 * Localizer: looks up a translation key for a given language, falling back to the default
 * language, then to the key itself. Supports `{var}` interpolation.
 */
export class Localizer {
  constructor(
    private readonly defaultLanguage: string,
    private readonly map: TranslationMap = translations,
  ) {}

  /** All languages that appear in at least one translation key. Drives the /language keyboard. */
  supportedLanguages(): string[] {
    const langs = new Set<string>();
    for (const key of Object.keys(this.map)) {
      const entry = this.map[key];
      if (!entry) continue;
      for (const lang of Object.keys(entry)) langs.add(lang);
    }
    return [...langs].sort();
  }

  has(key: string): boolean {
    return key in this.map;
  }

  /**
   * Resolve a key in the given language with `{var}` interpolation.
   * Returns null if the key is unknown (so callers can decide on a fallback).
   */
  t(key: string, vars: Record<string, string | number> = {}, language?: string): string | null {
    const entry = this.map[key];
    if (!entry) return null;
    const lang = language ?? this.defaultLanguage;
    const template = entry[lang] ?? entry[this.defaultLanguage] ?? Object.values(entry)[0];
    if (template === undefined) return null;
    return interpolate(template, vars);
  }
}

function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const v = vars[name];
    return v === undefined ? match : String(v);
  });
}
