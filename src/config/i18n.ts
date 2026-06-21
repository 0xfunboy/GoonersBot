/**
 * Localization for GoonersBot.
 *
 * Ports the original TelegramRPBot localizer mechanism (per-chat language, key lookup with
 * `{var}` interpolation, fallback to default language) but rebrands ALL copy to the
 * group-native GoonersBot / Gooners voice. The "⚡ lightning" theme and the old RP/Flagro
 * branding are gone.
 *
 * Italian is the default/primary language (DEFAULT_LANGUAGE=italian). English, Russian and Spanish
 * are provided too; the chat language is changeable at runtime with /language.
 */

export type LanguageMap = Record<string, string>;
export type TranslationMap = Record<string, LanguageMap>;

const GITHUB_URL = 'https://github.com/0xfunboy/GoonersBot';

export const translations: TranslationMap = {
  // ---- command descriptions (shown in the Telegram command menu) ----
  start_description: {
    italian: 'Sveglia GoonersBot in questa chat',
    english: 'Wake GoonersBot up in this chat',
    russian: 'Разбудить GoonersBot в этом чате',
    spanish: 'Despierta a GoonersBot en este chat',
  },
  stop_description: {
    italian: 'Metti GoonersBot a nanna in questa chat',
    english: 'Put GoonersBot to sleep in this chat',
    russian: 'Усыпить GoonersBot в этом чате',
    spanish: 'Duerme a GoonersBot en este chat',
  },
  reset_description: {
    italian: 'Cancella la memoria della conversazione di questa chat',
    english: 'Wipe the conversation memory for this chat',
    russian: 'Очистить память разговора в этом чате',
    spanish: 'Borra la memoria de conversación de este chat',
  },
  mode_description: {
    italian: 'Scegli la modalità di GoonersBot',
    english: 'Pick the mode GoonersBot runs in',
    russian: 'Выбрать режим GoonersBot',
    spanish: 'Elige el modo de GoonersBot',
  },
  addmode_description: {
    italian: 'Aggiungi una modalità custom a questa chat',
    english: 'Add a custom mode for this chat',
    russian: 'Добавить свой режим для этого чата',
    spanish: 'Agrega un modo personalizado a este chat',
  },
  deletemode_description: {
    italian: 'Elimina una modalità da questa chat',
    english: 'Delete a mode from this chat',
    russian: 'Удалить режим из этого чата',
    spanish: 'Elimina un modo de este chat',
  },
  introduce_description: {
    italian: 'Dì a GoonersBot chi sei',
    english: 'Tell GoonersBot who you are',
    russian: 'Расскажи GoonersBot, кто ты',
    spanish: 'Dile a GoonersBot quién eres',
  },
  fact_description: {
    italian: 'Estrai lore dalla chat recente (o dal messaggio in reply)',
    english: 'Mine lore from recent chat (or the replied message)',
    russian: 'Извлечь лор из недавнего чата (или из сообщения в ответе)',
    spanish: 'Extrae lore del chat reciente (o del mensaje citado)',
  },
  facts_description: {
    italian: 'Mostra i fatti salvati su un Gooner',
    english: 'Show stored facts about a Gooner',
    russian: 'Показать сохранённые факты о пользователе',
    spanish: 'Muestra los datos guardados sobre un Gooner',
  },
  clearfacts_description: {
    italian: 'Cancella i fatti di un Gooner',
    english: 'Clear facts for a Gooner',
    russian: 'Очистить факты о пользователе',
    spanish: 'Borra los datos de un Gooner',
  },
  usage_description: {
    italian: 'Mostra il tuo utilizzo e i limiti',
    english: 'Show your usage and limits',
    russian: 'Показать использование и лимиты',
    spanish: 'Muestra tu uso y límites',
  },
  language_description: {
    italian: 'Imposta la lingua della chat',
    english: 'Set the chat language',
    russian: 'Установить язык чата',
    spanish: 'Configura el idioma del chat',
  },
  terms_description: {
    italian: "Vedi i termini d'uso e il tuo stato di accettazione",
    english: 'View terms of use and your acceptance state',
    russian: 'Посмотреть условия использования и статус',
    spanish: 'Ver términos de uso y tu estado de aceptación',
  },
  tos_description: {
    italian: "Firma o revoca i termini d'uso",
    english: 'Sign or revoke the terms of service',
    russian: 'Принять или отозвать условия использования',
    spanish: 'Firma o revoca los términos de servicio',
  },
  conversationtracker_description: {
    italian: 'Attiva/disattiva il tracking della conversazione',
    english: 'Toggle conversation tracking',
    russian: 'Включить/выключить отслеживание разговора',
    spanish: 'Activa/desactiva el seguimiento de la conversación',
  },
  autofact_description: {
    italian: "Attiva/disattiva l'estrazione automatica dei fatti",
    english: 'Toggle automatic fact extraction',
    russian: 'Включить/выключить автоизвлечение фактов',
    spanish: 'Activa/desactiva la extracción automática de datos',
  },
  autoengage_description: {
    italian: "Attiva/disattiva l'auto-intervento (il bot si intromette da solo)",
    english: 'Toggle auto-engage (bot jumps in on its own)',
    russian: 'Включить/выключить авто-участие',
    spanish: 'Activa/desactiva la auto-participación',
  },
  autopost_description: {
    italian: 'Attiva/disattiva i post autonomi (news/immagini) in questa chat',
    english: 'Toggle autonomous posts (news/images) in this chat',
    russian: 'Включить/выключить автономные посты (новости/картинки)',
    spanish: 'Activa/desactiva las publicaciones autónomas (noticias/imágenes)',
  },
  autopost_turned_on: {
    italian: 'Post autonomi ON. Ogni tanto sbuco da solo, occhio.',
    english: "Autonomous posts ON. I'll pop in on my own now and then.",
    russian: 'Автопосты ВКЛ. Буду иногда вылезать сам.',
    spanish: 'Publicaciones autónomas ON. Apareceré por mi cuenta de vez en cuando.',
  },
  autopost_turned_off: {
    italian: 'Post autonomi OFF. Tornate a annoiarvi da soli.',
    english: 'Autonomous posts OFF. Back to boring yourselves.',
    russian: 'Автопосты ВЫКЛ.',
    spanish: 'Publicaciones autónomas OFF.',
  },
  linkmedia_description: {
    italian: 'Attiva/disattiva il re-upload automatico dei link media in questa chat',
    english: 'Toggle automatic rehosting of media links in this chat',
    russian: 'Включить/выключить авто-перезалив медиа-ссылок в этом чате',
    spanish: 'Activa/desactiva la resubida automática de enlaces multimedia en este chat',
  },
  linkmedia_turned_on: {
    italian: 'Rehost link ON. Mi pappo i vostri link e ve li ricarico qua.',
    english: 'Link rehost ON. I eat your links and spit them back as attachments.',
    russian: 'Перезалив ссылок ВКЛ.',
    spanish: 'Resubida de enlaces ON. Me como vuestros enlaces y os los devuelvo aquí.',
  },
  linkmedia_turned_off: {
    italian: 'Rehost link OFF. Arrangiatevi con le anteprime di merda.',
    english: 'Link rehost OFF. Enjoy your crappy previews.',
    russian: 'Перезалив ссылок ВЫКЛ.',
    spanish: 'Resubida de enlaces OFF. Disfrutad de vuestras previsualizaciones de mierda.',
  },
  news_unavailable: {
    italian: 'Niente news adesso, le fonti fanno i capricci. Riprova.',
    english: 'No news right now, the sources are being little shits. Try again.',
    russian: 'Сейчас новостей нет, источники капризничают. Попробуй снова.',
    spanish: 'No hay noticias ahora, las fuentes están dando guerra. Inténtalo de nuevo.',
  },
  news_description: {
    italian: 'Sparo un commento su un fatto del giorno (o una waifu)',
    english: 'Drop a take on a current event (or a waifu)',
    russian: 'Выдать мнение о событии дня (или вайфу)',
    spanish: 'Suelta una opinión sobre un hecho del día (o una waifu)',
  },
  genera_description: {
    italian: "Genera un'immagine originale con Stable Diffusion",
    english: 'Generate an original image with Stable Diffusion',
    russian: 'Создать оригинальное изображение через Stable Diffusion',
    spanish: 'Genera una imagen original con Stable Diffusion',
  },
  disegna_description: {
    italian: 'Illustrazione manga ad alta qualita con PonyXL',
    english: 'High-quality manga illustration with PonyXL',
    russian: 'Качественная манга-иллюстрация через PonyXL',
    spanish: 'Ilustracion manga de alta calidad con PonyXL',
  },
  ban_description: {
    italian: 'Banna un Gooner (solo admin)',
    english: 'Ban a Gooner (admin only)',
    russian: 'Забанить пользователя (только админ)',
    spanish: 'Banea a un Gooner (solo admin)',
  },
  unban_description: {
    italian: 'Sbanna un Gooner (solo admin)',
    english: 'Unban a Gooner (admin only)',
    russian: 'Разбанить пользователя (только админ)',
    spanish: 'Desbanea a un Gooner (solo admin)',
  },
  nsfw_description: {
    italian: 'Routing modello NSFW: off | base | smart (admin)',
    english: 'NSFW model routing: off | base | smart (admin)',
    russian: 'Режим NSFW-модели: off | base | smart (админ)',
    spanish: 'Enrutado del modelo NSFW: off | base | smart (admin)',
  },
  help_description: {
    italian: 'Mostra cosa sa fare GoonersBot',
    english: 'Show what GoonersBot can do',
    russian: 'Показать возможности GoonersBot',
    spanish: 'Muestra lo que GoonersBot puede hacer',
  },
  default_command_description: {
    italian: 'Un comando di GoonersBot',
    english: 'A GoonersBot command',
    russian: 'Команда GoonersBot',
    spanish: 'Un comando de GoonersBot',
  },
  setfact_description: {
    italian: 'Inserisci lore manuale (solo admin)',
    english: 'Manually insert lore (admin only)',
    russian: 'Вручную добавить лор (только админ)',
    spanish: 'Inserta lore manualmente (solo admin)',
  },
  lore_description: {
    italian: 'Mostra la lore top del gruppo',
    english: 'Show the top group lore',
    russian: 'Показать топ-лор группы',
    spanish: 'Muestra la lore principal del grupo',
  },
  forget_description: {
    italian: 'Dimentica un pezzo di lore (rispondi al messaggio)',
    english: 'Forget a piece of lore (reply to the message)',
    russian: 'Забыть кусок лора (ответом на сообщение)',
    spanish: 'Olvida un trozo de lore (responde al mensaje)',
  },
  brain_description: {
    italian: 'Mostra l’ultimo ragionamento (admin)',
    english: 'Show the last brain turn (admin)',
    russian: 'Показать последний ход мозга (админ)',
    spanish: 'Muestra el último turno del cerebro (admin)',
  },
  debuglast_description: {
    italian: 'Dump JSON dell’ultimo turno (admin)',
    english: 'JSON dump of the last turn (admin)',
    russian: 'JSON-дамп последнего хода (админ)',
    spanish: 'Volcado JSON del último turno (admin)',
  },
  voice_description: {
    italian: 'Trasforma in vocale l’ultimo messaggio (o quello in reply)',
    english: 'Turn the last message (or the replied one) into a voice note',
    russian: 'Озвучить последнее сообщение (или то, на которое отвечаешь)',
    spanish: 'Convierte en nota de voz el último mensaje (o el citado)',
  },
  voice_unavailable: {
    italian: 'Il TTS non è configurato su questo backend.',
    english: 'TTS is not configured on this backend.',
    russian: 'TTS не настроен на этом бэкенде.',
    spanish: 'El TTS no está configurado en este backend.',
  },
  voice_none: {
    italian: 'Non trovo un messaggio da trasformare in vocale.',
    english: "Can't find a message to voice.",
    russian: 'Не нахожу сообщение для озвучки.',
    spanish: 'No encuentro un mensaje para convertir en voz.',
  },
  voice_failed: {
    italian: 'La sintesi vocale è andata a male. Riprova.',
    english: 'Voice synthesis broke. Try again.',
    russian: 'Синтез речи сломался. Попробуй снова.',
    spanish: 'La síntesis de voz falló. Inténtalo de nuevo.',
  },
  play_description: {
    italian: 'Cerca un brano su YouTube e lo manda come vocale (es. /play despacito)',
    english: 'Search YouTube for a track and send it as a voice note (e.g. /play despacito)',
    russian: 'Найти трек на YouTube и прислать голосовым (напр. /play despacito)',
    spanish: 'Busca una canción en YouTube y la envía como nota de voz (p. ej. /play despacito)',
  },
  sing_description: {
    italian: 'Come /play: ti canta un brano da YouTube (es. /sing piccola kitty)',
    english: 'Like /play: sings you a YouTube track (e.g. /sing piccola kitty)',
    russian: 'Как /play: споёт трек с YouTube (напр. /sing piccola kitty)',
    spanish: 'Como /play: te canta una canción de YouTube (p. ej. /sing piccola kitty)',
  },
  music_unavailable: {
    italian: 'Il modulo musica non è configurato (manca yt-dlp o ffmpeg).',
    english: 'The music module is not configured (yt-dlp or ffmpeg missing).',
    russian: 'Музыкальный модуль не настроен (нет yt-dlp или ffmpeg).',
    spanish: 'El módulo de música no está configurado (falta yt-dlp o ffmpeg).',
  },
  music_none: {
    italian: 'E cosa ti suono, il silenzio? Dimmi un titolo: /play <brano>.',
    english: 'And what do I play, silence? Give me a title: /play <track>.',
    russian: 'И что мне играть, тишину? Назови трек: /play <название>.',
    spanish: '¿Y qué te toco, el silencio? Dime un título: /play <canción>.',
  },
  music_not_found: {
    italian: 'Non ho trovato un cazzo per "{query}". Prova con un altro titolo.',
    english: 'Found jack shit for "{query}". Try another title.',
    russian: 'Ни хрена не нашёл по "{query}". Попробуй другое название.',
    spanish: 'No encontré una mierda para "{query}". Prueba con otro título.',
  },
  translate_description: {
    italian: 'Traduci il messaggio in reply nella lingua indicata (es. /translate spagnolo)',
    english: 'Translate the replied message into the given language (e.g. /translate spanish)',
    russian: 'Перевести сообщение из реплая на указанный язык (напр. /translate russian)',
    spanish: 'Traduce el mensaje citado al idioma indicado (p. ej. /translate español)',
  },
  translate_usage: {
    italian: 'Usalo in risposta a un messaggio: /translate <lingua> (es. "/translate spagnolo").',
    english: 'Use it as a reply to a message: /translate <language> (e.g. "/translate spanish").',
    russian: 'Используй в ответ на сообщение: /translate <язык> (напр. "/translate russian").',
    spanish: 'Úsalo respondiendo a un mensaje: /translate <idioma> (p. ej. "/translate español").',
  },
  translate_no_target: {
    italian: 'In che lingua? Es: "/translate spagnolo" o "/translate in inglese".',
    english: 'Into which language? E.g. "/translate spanish" or "/translate to english".',
    russian: 'На какой язык? Напр.: "/translate spanish" или "/translate in english".',
    spanish: '¿A qué idioma? Ej: "/translate español" o "/translate al inglés".',
  },
  translate_nothing: {
    italian: 'Non trovo il testo del messaggio a cui rispondi.',
    english: "Can't find the text of the message you're replying to.",
    russian: 'Не нахожу текст сообщения, на которое ты отвечаешь.',
    spanish: 'No encuentro el texto del mensaje al que respondes.',
  },
  translate_failed: {
    italian: 'Traduzione fallita. Riprova.',
    english: 'Translation failed. Try again.',
    russian: 'Перевод не удался. Попробуй снова.',
    spanish: 'La traducción falló. Inténtalo de nuevo.',
  },

  // ---- responses ----
  start_done: {
    italian: 'GoonersBot è sveglio. Si cucina. 🍳',
    english: "GoonersBot is awake. Let's cook. 🍳",
    russian: 'GoonersBot проснулся. Погнали. 🍳',
    spanish: 'GoonersBot está despierto. A cocinar. 🍳',
  },
  stop_done: {
    italian: 'GoonersBot va in stand-by. Chiamami quando ti serve di nuovo il caos.',
    english: 'GoonersBot going dark. Ping me when you need chaos again.',
    russian: 'GoonersBot уходит в тень. Зовите, когда снова понадобится хаос.',
    spanish: 'GoonersBot se apaga. Llámame cuando quieras caos otra vez.',
  },
  reset_done: {
    italian: 'Memoria cancellata. Tabula rasa, e tu chi sei.',
    english: 'Memory wiped. Clean slate, who dis.',
    russian: 'Память очищена. Чистый лист, кто это вообще.',
    spanish: 'Memoria borrada. Borrón y cuenta nueva, ¿quién eres?',
  },
  choose_mode: {
    italian: 'Scegli una modalità:',
    english: 'Pick a mode:',
    russian: 'Выбери режим:',
    spanish: 'Elige un modo:',
  },
  choose_mode_to_delete: {
    italian: 'Quale modalità faccio fuori?',
    english: 'Which mode should I nuke?',
    russian: 'Какой режим удалить?',
    spanish: '¿Qué modo elimino?',
  },
  mode_set: {
    italian: 'Ora giro in modalità {mode_name}.',
    english: 'Now running in {mode_name}.',
    russian: 'Теперь работаю в режиме {mode_name}.',
    spanish: 'Ahora en modo {mode_name}.',
  },
  mode_added: {
    italian: 'Modalità {mode_name} aggiunta.',
    english: 'Mode {mode_name} locked in.',
    russian: 'Режим {mode_name} добавлен.',
    spanish: 'Modo {mode_name} agregado.',
  },
  mode_deleted: {
    italian: 'Modalità {mode_name} eliminata.',
    english: 'Mode {mode_name} deleted.',
    russian: 'Режим {mode_name} удалён.',
    spanish: 'Modo {mode_name} eliminado.',
  },
  inappropriate_mode: {
    italian: 'Quella modalità no. Prova qualcosa che non ci faccia bannare.',
    english: "That mode's a no. Try something that won't get us banned.",
    russian: 'Такой режим - нет. Попробуй что-то поспокойнее.',
    spanish: 'Ese modo no. Prueba con algo que no nos banee.',
  },
  invalid_mode_args: {
    italian: 'Uso: /addmode <descrizione>',
    english: 'Usage: /addmode <description>',
    russian: 'Использование: /addmode <описание>',
    spanish: 'Uso: /addmode <descripción>',
  },
  introduction_added: {
    italian: 'Segnato, {user_handle}. Benvenuto nella lore.',
    english: 'Noted, {user_handle}. Welcome to the lore.',
    russian: 'Записал, {user_handle}. Добро пожаловать в историю.',
    spanish: 'Anotado, {user_handle}. Bienvenido a la lore.',
  },
  inappropriate_introduction: {
    italian: 'Questa presentazione non la salvo. Tienila pulitina.',
    english: "Can't save that intro. Keep it clean-ish.",
    russian: 'Не могу сохранить такое представление.',
    spanish: 'No puedo guardar esa presentación.',
  },
  invalid_fact_args: {
    italian: 'Uso: /fact @handle <il fatto>',
    english: 'Usage: /fact @handle <the fact>',
    russian: 'Использование: /fact @handle <факт>',
    spanish: 'Uso: /fact @handle <el dato>',
  },
  fact_added: {
    italian: 'Fatto su {user_handle} salvato.',
    english: 'Fact about {user_handle} saved.',
    russian: 'Факт о {user_handle} сохранён.',
    spanish: 'Dato sobre {user_handle} guardado.',
  },
  inappropriate_fact: {
    italian: 'Questo non lo salvo. Fatti sicuri e non inquietanti.',
    english: 'Not saving that one. Keep facts safe and non-creepy.',
    russian: 'Такой факт не сохраню.',
    spanish: 'Ese dato no lo guardo.',
  },
  user_facts: {
    italian: 'Cosa so di {user_handle}:\n- {facts}',
    english: 'What I know about {user_handle}:\n- {facts}',
    russian: 'Что я знаю о {user_handle}:\n- {facts}',
    spanish: 'Lo que sé de {user_handle}:\n- {facts}',
  },
  user_facts_empty: {
    italian: 'Non ho ancora niente su {user_handle}.',
    english: "I've got nothing on {user_handle} yet.",
    russian: 'Пока ничего нет о {user_handle}.',
    spanish: 'Aún no tengo nada de {user_handle}.',
  },
  facts_cleared: {
    italian: 'Lore su {user_handle} archiviata. Tabula rasa.',
    english: 'Lore about {user_handle} wiped.',
    russian: 'Лор о {user_handle} очищен.',
    spanish: 'Lore sobre {user_handle} borrada.',
  },
  fact_mined: {
    italian:
      'Salvati {stored} pezzi di lore ({reinforced} rinforzati). Il resto era rumore da cortile.',
    english: 'Saved {stored} lore bits ({reinforced} reinforced). The rest was background noise.',
    russian: 'Сохранил {stored} кусков лора ({reinforced} усилено). Остальное - шум.',
    spanish: 'Guardé {stored} trozos de lore ({reinforced} reforzados). El resto era ruido.',
  },
  fact_mined_none: {
    italian: 'Niente di degno da ricordare qui. Riprova quando dite qualcosa di memorabile.',
    english: 'Nothing worth remembering here. Try again when you say something memorable.',
    russian: 'Тут нечего запоминать. Попробуй, когда скажете что-то стоящее.',
    spanish: 'Nada digno de recordar. Vuelve cuando digáis algo memorable.',
  },
  setfact_added: {
    italian: 'Lore su {user_handle} incisa nella pietra.',
    english: 'Lore about {user_handle} carved in stone.',
    russian: 'Лор о {user_handle} высечен в камне.',
    spanish: 'Lore sobre {user_handle} grabada en piedra.',
  },
  setfact_usage: {
    italian: 'Uso: /setfact @handle <testo> oppure /setfact <lore di gruppo>',
    english: 'Usage: /setfact @handle <text> or /setfact <group lore>',
    russian: 'Использование: /setfact @handle <текст> или /setfact <лор группы>',
    spanish: 'Uso: /setfact @handle <texto> o /setfact <lore de grupo>',
  },
  lore_text: {
    italian: '📜 Lore del gruppo:\n{lore}',
    english: '📜 Group lore:\n{lore}',
    russian: '📜 Лор группы:\n{lore}',
    spanish: '📜 Lore del grupo:\n{lore}',
  },
  lore_empty: {
    italian: 'Ancora nessuna lore. Vivete di più e tornate.',
    english: 'No lore yet. Go live a little and come back.',
    russian: 'Пока нет лора. Поживите немного и вернитесь.',
    spanish: 'Aún no hay lore. Vivid un poco y volved.',
  },
  forget_done: {
    italian: 'Dimenticato. Quel ricordo non esiste più, come la tua dignità.',
    english: 'Forgotten. That memory is gone, like your dignity.',
    russian: 'Забыто. Этого воспоминания больше нет, как и твоего достоинства.',
    spanish: 'Olvidado. Ese recuerdo ya no existe, como tu dignidad.',
  },
  forget_none: {
    italian: 'Non c’era lore collegata a quel messaggio.',
    english: 'No lore was tied to that message.',
    russian: 'С тем сообщением не связан лор.',
    spanish: 'No había lore ligada a ese mensaje.',
  },
  forget_usage: {
    italian: 'Rispondi a un messaggio con /forget, oppure (admin) /forget <id>.',
    english: 'Reply to a message with /forget, or (admin) /forget <id>.',
    russian: 'Ответь на сообщение командой /forget, или (админ) /forget <id>.',
    spanish: 'Responde a un mensaje con /forget, o (admin) /forget <id>.',
  },
  clearfacts_forbidden: {
    italian: 'Solo gli admin possono cancellare i fatti di altri Gooner.',
    english: 'Only admins can clear facts about other Gooners.',
    russian: 'Только админы могут очищать чужие факты.',
    spanish: 'Solo los admins pueden borrar datos de otros Gooners.',
  },
  invalid_clearfacts_args: {
    italian: 'Uso: /clearfacts [@handle]',
    english: 'Usage: /clearfacts [@handle]',
    russian: 'Использование: /clearfacts [@handle]',
    spanish: 'Uso: /clearfacts [@handle]',
  },
  usage_text: {
    italian: 'Utilizzo di questo periodo: {this_month_usage} / {limit} punti.',
    english: 'Usage this period: {this_month_usage} / {limit} points.',
    russian: 'Использование за период: {this_month_usage} / {limit} очков.',
    spanish: 'Uso este periodo: {this_month_usage} / {limit} puntos.',
  },
  usage_limit_exceeded: {
    italian: '{user_handle}, hai raggiunto il limite ({usage_limit}). Datti una calmata.',
    english: '{user_handle}, you hit your usage limit ({usage_limit}). Cool down a bit.',
    russian: '{user_handle}, ты достиг лимита ({usage_limit}). Остынь немного.',
    spanish: '{user_handle}, llegaste a tu límite ({usage_limit}). Relájate un poco.',
  },
  choose_language: {
    italian: 'Scegli una lingua:',
    english: 'Pick a language:',
    russian: 'Выбери язык:',
    spanish: 'Elige un idioma:',
  },
  language_set: {
    italian: 'Lingua impostata su {language}.',
    english: 'Language set to {language}.',
    russian: 'Язык установлен: {language}.',
    spanish: 'Idioma configurado: {language}.',
  },
  not_authenticated: {
    italian: 'Questo qui non puoi farlo.',
    english: "You can't do that here.",
    russian: 'Тебе сюда нельзя.',
    spanish: 'No puedes hacer eso aquí.',
  },
  conversation_tracker_turned_on: {
    italian: 'Tracking conversazione ATTIVO. Ora ascolto.',
    english: "Conversation tracking ON. I'm listening now.",
    russian: 'Отслеживание разговора ВКЛ. Слушаю.',
    spanish: 'Seguimiento de conversación ACTIVADO. Estoy escuchando.',
  },
  conversation_tracker_turned_off: {
    italian: 'Tracking conversazione OFF. Rispondo solo se mi chiami.',
    english: 'Conversation tracking OFF. I only reply when poked.',
    russian: 'Отслеживание разговора ВЫКЛ. Отвечаю только когда зовут.',
    spanish: 'Seguimiento de conversación DESACTIVADO. Solo respondo si me llaman.',
  },
  autoengage_turned_on: {
    italian: 'Auto-intervento ATTIVO. Mi intrometto quando ne vale la pena.',
    english: "Auto-engage ON. I'll jump in when it's worth it.",
    russian: 'Авто-участие ВКЛ. Влезу, когда будет повод.',
    spanish: 'Auto-participación ACTIVADA. Me meteré cuando valga la pena.',
  },
  autoengage_turned_off: {
    italian: 'Auto-intervento OFF. Aspetto che mi chiamiate.',
    english: "Auto-engage OFF. I'll wait to be called.",
    russian: 'Авто-участие ВЫКЛ. Жду, когда позовут.',
    spanish: 'Auto-participación DESACTIVADA. Esperaré a que me llamen.',
  },
  autofact_turned_on: {
    italian: 'Auto-fatti ATTIVI. Mi ricordo le cose buone.',
    english: "Auto-facts ON. I'll remember the good stuff.",
    russian: 'Авто-факты ВКЛ. Запомню важное.',
    spanish: 'Auto-datos ACTIVADOS. Recordaré lo bueno.',
  },
  autofact_turned_off: {
    italian: 'Auto-fatti OFF. Solo memoria manuale.',
    english: 'Auto-facts OFF. Manual memory only.',
    russian: 'Авто-факты ВЫКЛ. Только ручная память.',
    spanish: 'Auto-datos DESACTIVADOS. Solo memoria manual.',
  },
  nsfw_unavailable: {
    italian: 'Il routing NSFW non è configurato su questo backend (nessun modello NSFW).',
    english: 'NSFW routing is not configured on this backend (no NSFW model set).',
    russian: 'NSFW-маршрутизация не настроена (модель NSFW не задана).',
    spanish: 'El enrutado NSFW no está configurado (sin modelo NSFW).',
  },
  nsfw_status: {
    italian: 'Routing NSFW di questa chat: {mode}. Usa /nsfw off|base|smart.',
    english: 'NSFW routing for this chat: {mode}. Use /nsfw off|base|smart.',
    russian: 'NSFW-режим этого чата: {mode}. Используй /nsfw off|base|smart.',
    spanish: 'Enrutado NSFW de este chat: {mode}. Usa /nsfw off|base|smart.',
  },
  nsfw_invalid: {
    italian: 'Uso: /nsfw off | base | smart (oppure on = base).',
    english: 'Usage: /nsfw off | base | smart (or on = base).',
    russian: 'Использование: /nsfw off | base | smart (или on = base).',
    spanish: 'Uso: /nsfw off | base | smart (o on = base).',
  },
  nsfw_set_off: {
    italian: 'Routing NSFW OFF. Qui uso sempre il modello di default.',
    english: 'NSFW routing OFF. Always using the default model here.',
    russian: 'NSFW ВЫКЛ. Здесь всегда обычная модель.',
    spanish: 'NSFW DESACTIVADO. Aquí siempre el modelo por defecto.',
  },
  nsfw_set_base: {
    italian: 'Routing NSFW ATTIVO (base). Tutta la chat usa il modello senza censura. 🔞',
    english: 'NSFW routing ON (base). This whole chat uses the uncensored model. 🔞',
    russian: 'NSFW ВКЛ (base). Весь чат использует нецензурную модель. 🔞',
    spanish: 'NSFW ACTIVADO (base). Todo el chat usa el modelo sin censura. 🔞',
  },
  nsfw_set_smart: {
    italian: 'Routing NSFW ATTIVO (smart). Passo al modello senza censura quando serve. 🔞',
    english:
      'NSFW routing ON (smart). I switch to the uncensored model when the vibe calls for it. 🔞',
    russian: 'NSFW ВКЛ (smart). Переключаюсь на нецензурную модель, когда нужно. 🔞',
    spanish: 'NSFW ACTIVADO (smart). Cambio al modelo sin censura cuando hace falta. 🔞',
  },
  user_banned: {
    italian: '{user_handle} bannato{ban_suffix}.',
    english: '{user_handle} banned{ban_suffix}.',
    russian: '{user_handle} забанен{ban_suffix}.',
    spanish: '{user_handle} baneado{ban_suffix}.',
  },
  user_unbanned: {
    italian: '{user_handle} sbannato. Comportati, stavolta.',
    english: '{user_handle} unbanned. Behave this time.',
    russian: '{user_handle} разбанен. Веди себя прилично.',
    spanish: '{user_handle} desbaneado. Pórtate bien esta vez.',
  },
  invalid_ban_args: {
    italian: 'Uso: /ban @handle [secondi] (o rispondi a un messaggio con /ban [secondi])',
    english: 'Usage: /ban @handle [seconds] (or reply to a message with /ban [seconds])',
    russian: 'Использование: /ban @handle [секунды] (или ответом на сообщение)',
    spanish: 'Uso: /ban @handle [segundos] (o responde a un mensaje con /ban [segundos])',
  },
  invalid_unban_args: {
    italian: 'Uso: /unban @handle',
    english: 'Usage: /unban @handle',
    russian: 'Использование: /unban @handle',
    spanish: 'Uso: /unban @handle',
  },
  message_response: {
    italian: '{response_text}',
    english: '{response_text}',
    russian: '{response_text}',
    spanish: '{response_text}',
  },
  streaming_message_response: {
    italian: '{response_text}',
    english: '{response_text}',
    russian: '{response_text}',
    spanish: '{response_text}',
  },
  message_moderation_failed: {
    italian: 'No, questo non lo dico. ({moderation_reason})',
    english: "Yeah, I'm not saying that. ({moderation_reason})",
    russian: 'Не, такое я не скажу. ({moderation_reason})',
    spanish: 'No, eso no lo digo. ({moderation_reason})',
  },
  capability_unavailable: {
    italian: 'Ora non posso - {capability} non è configurato su questo backend.',
    english: "I can't do that right now - {capability} isn't set up on this backend.",
    russian: 'Сейчас не могу - {capability} не настроен на этом бэкенде.',
    spanish: 'No puedo hacer eso ahora - {capability} no está configurado en este backend.',
  },
  generation_failed: {
    italian: 'Si è rotto qualcosa da me. Riprova tra un attimo.',
    english: 'That broke on my end. Try again in a sec.',
    russian: 'Что-то сломалось. Попробуй ещё раз.',
    spanish: 'Algo se rompió de mi lado. Inténtalo de nuevo.',
  },
  terms_accept_button: {
    italian: '✅ Accetto',
    english: '✅ Accept',
    russian: '✅ Принять',
    spanish: '✅ Aceptar',
  },
  terms_decline_button: {
    italian: '❌ Rifiuto',
    english: '❌ Decline',
    russian: '❌ Отклонить',
    spanish: '❌ Rechazar',
  },
  terms_accepted: {
    italian: 'Grazie {user_handle}, termini accettati: sei dentro. 🤝',
    english: 'Thanks {user_handle}, terms accepted: you are in. 🤝',
    russian: 'Спасибо, {user_handle}, условия приняты: ты в деле. 🤝',
    spanish: 'Gracias {user_handle}, términos aceptados: estás dentro. 🤝',
  },
  terms_declined: {
    italian:
      '{user_handle} ha rifiutato i termini. I dati salvati sono stati cancellati. Accetta i termini per usare GoonersBot.',
    english:
      '{user_handle} declined the terms. Stored data was cleared. Accept the terms to use GoonersBot.',
    russian:
      '{user_handle} отклонил условия. Данные удалены. Прими условия, чтобы пользоваться GoonersBot.',
    spanish:
      '{user_handle} rechazó los términos. Los datos fueron borrados. Acepta los términos para usar GoonersBot.',
  },
  terms_already_accepted: {
    italian: 'Hai già accettato i termini. Tutto ok. 🤝',
    english: 'You already accepted the terms. All good. 🤝',
    russian: 'Ты уже принял условия. Всё ок. 🤝',
    spanish: 'Ya aceptaste los términos. Todo bien. 🤝',
  },
  invalid_terms_action: {
    italian: "Quell'azione sui termini non ha funzionato. Riprova con /terms.",
    english: 'That terms action did not compute. Try /terms again.',
    russian: 'Это действие не сработало. Попробуй /terms снова.',
    spanish: 'Esa acción no funcionó. Intenta /terms de nuevo.',
  },
  terms_text: {
    italian: [
      "<strong>📋 Termini d'uso di GoonersBot</strong>",
      '',
      'Usando GoonersBot in questa chat accetti che:',
      '',
      '<strong>🔒 Dati e memoria</strong>',
      '• I <b>messaggi</b> possono essere elaborati e salvati per risposte contestuali e memoria di gruppo.',
      "• Le <b>immagini</b> che invii (quando ti rivolgi a GoonersBot) possono essere descritte dall'AI.",
      "• L'<b>audio</b> che invii (quando ti rivolgi a GoonersBot) può essere trascritto in testo.",
      '• I <b>fatti</b> su utenti/gruppo vengono salvati per tenere viva la lore.',
      "• L'<b>utilizzo</b> è tracciato in punti per applicare i limiti.",
      '',
      '<strong>⚡ I tuoi controlli</strong>',
      '• /reset cancella la memoria della conversazione.',
      '• /clearfacts cancella i fatti salvati.',
      '• /stop mette GoonersBot a nanna in questa chat.',
      '• Se rifiuti, i tuoi dati personalizzati vengono cancellati (termini e stato di ban restano per sicurezza).',
      '',
      `<strong>🔗 Open source:</strong> <a href="${GITHUB_URL}">GoonersBot su GitHub</a>`,
    ].join('\n'),
    english: [
      '<strong>📋 GoonersBot Terms of Use</strong>',
      '',
      'By using GoonersBot in this chat you agree that:',
      '',
      '<strong>🔒 Data &amp; Memory</strong>',
      '• <b>Messages</b> may be processed and stored to give context-aware replies and keep group memory.',
      '• <b>Images</b> you send (when GoonersBot is addressed) may be described by AI.',
      '• <b>Voice</b> you send (when GoonersBot is addressed) may be transcribed to text.',
      '• <b>Facts</b> about users/group are stored to keep the lore alive.',
      '• <b>Usage</b> is tracked as points to enforce limits.',
      '',
      '<strong>⚡ Your controls</strong>',
      '• /reset wipes the conversation memory.',
      '• /clearfacts wipes stored facts.',
      '• /stop puts GoonersBot to sleep in this chat.',
      '• Decline and your custom stored data is cleared (terms + ban status are kept for safety).',
      '',
      `<strong>🔗 Open source:</strong> <a href="${GITHUB_URL}">GoonersBot on GitHub</a>`,
    ].join('\n'),
    russian: [
      '<strong>📋 Условия использования GoonersBot</strong>',
      '',
      'Используя GoonersBot в этом чате, ты соглашаешься, что:',
      '',
      '<strong>🔒 Данные и память</strong>',
      '• <b>Сообщения</b> могут обрабатываться и храниться для контекстных ответов и групповой памяти.',
      '• <b>Изображения</b> (когда обращаются к GoonersBot) могут описываться ИИ.',
      '• <b>Голос</b> (когда обращаются к GoonersBot) может транскрибироваться.',
      '• <b>Факты</b> о пользователях/группе хранятся для истории.',
      '• <b>Использование</b> отслеживается в виде очков для лимитов.',
      '',
      '<strong>⚡ Твои возможности</strong>',
      '• /reset очищает память разговора.',
      '• /clearfacts очищает факты.',
      '• /stop усыпляет GoonersBot в этом чате.',
      '• Отказ - твои данные удаляются (условия и статус бана сохраняются).',
      '',
      `<strong>🔗 Открытый код:</strong> <a href="${GITHUB_URL}">GoonersBot на GitHub</a>`,
    ].join('\n'),
    spanish: [
      '<strong>📋 Términos de uso de GoonersBot</strong>',
      '',
      'Al usar GoonersBot en este chat aceptas que:',
      '',
      '<strong>🔒 Datos y memoria</strong>',
      '• Los <b>mensajes</b> pueden procesarse y almacenarse para respuestas con contexto y memoria de grupo.',
      '• Las <b>imágenes</b> que envíes (cuando te diriges a GoonersBot) pueden ser descritas por IA.',
      '• El <b>audio</b> que envíes (cuando te diriges a GoonersBot) puede transcribirse a texto.',
      '• Los <b>datos</b> de usuarios/grupo se guardan para mantener la lore.',
      '• El <b>uso</b> se rastrea como puntos para aplicar límites.',
      '',
      '<strong>⚡ Tus controles</strong>',
      '• /reset borra la memoria de conversación.',
      '• /clearfacts borra los datos guardados.',
      '• /stop duerme a GoonersBot en este chat.',
      '• Si rechazas, tus datos personalizados se borran (términos y estado de baneo se conservan).',
      '',
      `<strong>🔗 Código abierto:</strong> <a href="${GITHUB_URL}">GoonersBot en GitHub</a>`,
    ].join('\n'),
  },
  help_text: {
    italian: [
      '<strong>GoonersBot 🤖 - il gremlin del gruppo</strong>',
      'Bot di intrattenimento, roleplay, meme, banter e memoria per i Gooners.',
      '',
      '<strong>Cosa faccio</strong>',
      "• Leggo l'aria, ricordo la lore di gruppo e utenti, e mi intrometto quando è divertente o utile.",
      '• Giro in <b>modalità</b> diverse (default, roast, hype, lorekeeper, chaos, market_degen, meme_recorder).',
      '• Prendo testo, immagini e voce (quando mi parli) e rispondo con testo (e immagini/voce se configurati).',
      '',
      '<strong>Comandi</strong>',
      '• <em>/start</em> - sveglia in questa chat',
      '• <em>/stop</em> - mettimi a nanna',
      '• <em>/reset</em> - cancella la memoria',
      '• <em>/mode</em> - scegli una modalità',
      '• <em>/addmode &lt;descrizione&gt;</em> - aggiungi una modalità custom',
      '• <em>/deletemode</em> - elimina una modalità',
      '• <em>/introduce &lt;testo&gt;</em> - dimmi chi sei',
      '• <em>/fact</em> - estrai lore dalla chat (o dal messaggio in reply)',
      '• <em>/setfact @handle &lt;testo&gt;</em> (admin) - inserisci lore a mano',
      '• <em>/facts [@handle]</em> - mostra la lore salvata',
      '• <em>/clearfacts [@handle]</em> - cancella la lore',
      '• <em>/lore</em> - la lore top del gruppo',
      '• <em>/forget</em> - dimentica la lore (rispondi al messaggio)',
      '• <em>/usage</em> - il tuo utilizzo e i limiti',
      '• <em>/language</em> - imposta la lingua della chat',
      "• <em>/terms</em> - termini d'uso",
      '• <em>/conversationtracker</em> - ascolto passivo on/off',
      '• <em>/autofact</em> - estrazione fatti automatica on/off',
      '• <em>/autoengage</em> - auto-intervento on/off',
      '• <em>/nsfw off|base|smart</em> (admin) - routing modello NSFW',
      '• <em>/genera &lt;prompt&gt;</em> - genera un’immagine originale (alias /image, /img)',
      '• <em>/disegna &lt;prompt&gt;</em> - illustrazione manga ad alta qualità (alias /draw)',
      '• <em>/voice</em> - trasforma in vocale l’ultimo messaggio (o quello in reply)',
      '• <em>/ban @handle [secondi]</em> (admin) - banna un Gooner',
      '• <em>/unban @handle</em> (admin) - sbanna un Gooner',
      '• <em>/brain</em> · <em>/debuglast</em> (admin) - debug del cervello',
      '• <em>/help</em> - questo',
      '',
      `<strong>🔗</strong> <a href="${GITHUB_URL}">GoonersBot su GitHub</a>`,
    ].join('\n'),
    english: [
      '<strong>GoonersBot 🤖 - your group gremlin</strong>',
      'A group-native entertainment, roleplay, meme, banter &amp; memory bot for the Gooners.',
      '',
      '<strong>What I do</strong>',
      '• Read the room, remember group &amp; user lore, and jump in when it’s funny or useful.',
      '• Run different <b>modes</b> (default, roast, hype, lorekeeper, chaos, market_degen, meme_recorder).',
      '• Take text, images and voice (when you address me) and reply with text (and images/voice if configured).',
      '',
      '<strong>Commands</strong>',
      '• <em>/start</em> - wake me in this chat',
      '• <em>/stop</em> - put me to sleep',
      '• <em>/reset</em> - wipe conversation memory',
      '• <em>/mode</em> - pick a mode',
      '• <em>/addmode &lt;description&gt;</em> - add a custom mode',
      '• <em>/deletemode</em> - delete a mode',
      '• <em>/introduce &lt;text&gt;</em> - tell me who you are',
      '• <em>/fact</em> - mine lore from chat (or the replied message)',
      '• <em>/setfact @handle &lt;text&gt;</em> (admin) - insert lore manually',
      '• <em>/facts [@handle]</em> - show stored lore',
      '• <em>/clearfacts [@handle]</em> - clear lore',
      '• <em>/lore</em> - top group lore',
      '• <em>/forget</em> - forget lore (reply to the message)',
      '• <em>/usage</em> - your usage and limits',
      '• <em>/language</em> - set chat language',
      '• <em>/terms</em> - terms of use',
      '• <em>/conversationtracker</em> - toggle passive listening',
      '• <em>/autofact</em> - toggle auto fact extraction',
      '• <em>/autoengage</em> - toggle auto-engage',
      '• <em>/nsfw off|base|smart</em> (admin) - NSFW model routing',
      '• <em>/genera &lt;prompt&gt;</em> - generate an original image (aliases /image, /img)',
      '• <em>/disegna &lt;prompt&gt;</em> - high-quality manga illustration (alias /draw)',
      '• <em>/voice</em> - voice the last message (or the replied one)',
      '• <em>/ban @handle [seconds]</em> (admin) - ban a Gooner',
      '• <em>/unban @handle</em> (admin) - unban a Gooner',
      '• <em>/brain</em> · <em>/debuglast</em> (admin) - brain debug',
      '• <em>/help</em> - this',
      '',
      `<strong>🔗</strong> <a href="${GITHUB_URL}">GoonersBot on GitHub</a>`,
    ].join('\n'),
    russian: [
      '<strong>GoonersBot 🤖 - гремлин вашей группы</strong>',
      'Развлекательный, ролевой, мем- и память-бот для Gooners.',
      '',
      '<strong>Команды</strong>',
      '• <em>/start</em> - разбудить в этом чате',
      '• <em>/stop</em> - усыпить',
      '• <em>/reset</em> - очистить память',
      '• <em>/mode</em> - выбрать режим',
      '• <em>/addmode &lt;описание&gt;</em> - добавить режим',
      '• <em>/deletemode</em> - удалить режим',
      '• <em>/introduce &lt;текст&gt;</em> - рассказать о себе',
      '• <em>/fact @handle &lt;факт&gt;</em> - сохранить факт',
      '• <em>/facts [@handle]</em> - показать факты',
      '• <em>/clearfacts [@handle]</em> - очистить факты',
      '• <em>/usage</em> - использование и лимиты',
      '• <em>/language</em> - язык чата',
      '• <em>/terms</em> - условия',
      '• <em>/conversationtracker</em> - пассивное слушание',
      '• <em>/autofact</em> - авто-факты',
      '• <em>/autoengage</em> - авто-участие',
      '• <em>/genera &lt;запрос&gt;</em> - создать оригинальное изображение (алиасы /image, /img)',
      '• <em>/disegna &lt;запрос&gt;</em> - качественная манга-иллюстрация (алиас /draw)',
      '• <em>/ban @handle [секунды]</em> (админ) - забанить',
      '• <em>/unban @handle</em> (админ) - разбанить',
      '• <em>/help</em> - это',
      '',
      `<strong>🔗</strong> <a href="${GITHUB_URL}">GoonersBot на GitHub</a>`,
    ].join('\n'),
    spanish: [
      '<strong>GoonersBot 🤖 - el gremlin del grupo</strong>',
      'Bot de entretenimiento, roleplay, memes, banter y memoria para los Gooners.',
      '',
      '<strong>Comandos</strong>',
      '• <em>/start</em> - despertarme en este chat',
      '• <em>/stop</em> - dormirme',
      '• <em>/reset</em> - borrar memoria',
      '• <em>/mode</em> - elegir modo',
      '• <em>/addmode &lt;descripción&gt;</em> - agregar modo',
      '• <em>/deletemode</em> - eliminar modo',
      '• <em>/introduce &lt;texto&gt;</em> - preséntate',
      '• <em>/fact @handle &lt;dato&gt;</em> - guardar dato',
      '• <em>/facts [@handle]</em> - mostrar datos',
      '• <em>/clearfacts [@handle]</em> - borrar datos',
      '• <em>/usage</em> - uso y límites',
      '• <em>/language</em> - idioma del chat',
      '• <em>/terms</em> - términos',
      '• <em>/conversationtracker</em> - escucha pasiva',
      '• <em>/autofact</em> - auto-datos',
      '• <em>/autoengage</em> - auto-participación',
      '• <em>/genera &lt;prompt&gt;</em> - genera una imagen original (alias /image, /img)',
      '• <em>/disegna &lt;prompt&gt;</em> - ilustración manga de alta calidad (alias /draw)',
      '• <em>/ban @handle [segundos]</em> (admin) - banear',
      '• <em>/unban @handle</em> (admin) - desbanear',
      '• <em>/help</em> - esto',
      '',
      `<strong>🔗</strong> <a href="${GITHUB_URL}">GoonersBot en GitHub</a>`,
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
