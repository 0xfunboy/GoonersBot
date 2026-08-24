import type { CommandSpec } from '../types.js';

export type HelpLanguage = 'italian' | 'english' | 'spanish';

type Localized = Record<HelpLanguage, string>;

export type HelpCategory = 'chat' | 'memory' | 'media' | 'anime' | 'diagnostics' | 'administration';

export interface CommandHelpDefinition {
  category: HelpCategory;
  usage: Localized;
  description: Localized;
}

const l = (italian: string, english: string, spanish: string): Localized => ({
  italian,
  english,
  spanish,
});

/**
 * Long-form command help. Telegram's command menu deliberately keeps the shorter i18n
 * `*_description` strings; this catalog is the detailed reference used by /help and docs.
 * Every static CommandSpec must have one entry (enforced in commandRegistry.test.ts).
 */
export const COMMAND_HELP: Readonly<Record<string, CommandHelpDefinition>> = {
  start: {
    category: 'chat',
    usage: l('/start', '/start', '/start'),
    description: l(
      'Riattiva GoonersBot nella chat. Richiede un admin della chat o un bot admin configurato.',
      'Wake GoonersBot in the current chat. Requires a group admin or configured bot admin.',
      'Reactiva GoonersBot en el chat actual. Requiere un admin del grupo o un admin del bot configurado.',
    ),
  },
  stop: {
    category: 'chat',
    usage: l('/stop', '/stop', '/stop'),
    description: l(
      'Mette GoonersBot in stato stopped nella chat; i normali turni non vengono più gestiti finché non usi /start.',
      'Put GoonersBot in the stopped state for this chat; normal turns stay disabled until /start.',
      'Pone GoonersBot en estado stopped para este chat; los turnos normales quedan desactivados hasta /start.',
    ),
  },
  reset: {
    category: 'chat',
    usage: l('/reset', '/reset', '/reset'),
    description: l(
      'Azzera la memoria della conversazione corrente. Non cancella lore/fatti persistenti: per quelli usa /clearfacts o /forget.',
      'Reset the current conversation memory. It does not erase durable lore/facts; use /clearfacts or /forget for those.',
      'Reinicia la memoria de la conversación actual. No borra lore/datos persistentes; usa /clearfacts o /forget para eso.',
    ),
  },
  mode: {
    category: 'chat',
    usage: l('/mode', '/mode', '/mode'),
    description: l(
      'Apre la tastiera delle modalità disponibili e imposta il comportamento/persona della chat.',
      'Open the available-mode keyboard and select the chat behavior/persona.',
      'Abre el teclado de modos disponibles y selecciona el comportamiento/persona del chat.',
    ),
  },
  addmode: {
    category: 'chat',
    usage: l('/addmode <descrizione>', '/addmode <description>', '/addmode <descripción>'),
    description: l(
      'Crea una modalità custom per questa chat; il nome viene derivato dalla prima frase della descrizione.',
      'Create a custom mode for this chat; its name is derived from the first sentence of the description.',
      'Crea un modo personalizado para este chat; el nombre se deriva de la primera frase de la descripción.',
    ),
  },
  deletemode: {
    category: 'chat',
    usage: l('/deletemode', '/deletemode', '/deletemode'),
    description: l(
      'Apre la tastiera delle modalità della chat che possono essere eliminate.',
      'Open the keyboard of chat modes that can be deleted.',
      'Abre el teclado de modos del chat que se pueden eliminar.',
    ),
  },
  introduce: {
    category: 'memory',
    usage: l('/introduce <chi sei>', '/introduce <who you are>', '/introduce <quién eres>'),
    description: l(
      'Salva una tua auto-presentazione come lore durevole di tipo ruolo, attribuita al tuo handle.',
      'Store your self-introduction as durable role lore attached to your handle.',
      'Guarda tu presentación personal como lore persistente de tipo rol asociada a tu usuario.',
    ),
  },
  setfact: {
    category: 'administration',
    usage: l(
      '/setfact [@utente] <fatto/lore>',
      '/setfact [@user] <fact/lore>',
      '/setfact [@usuario] <dato/lore>',
    ),
    description: l(
      'Inserisce manualmente lore persistente. Con @utente la associa a quella persona; senza handle la salva come lore del gruppo.',
      'Manually insert durable lore. With @user it targets that person; without a handle it becomes group lore.',
      'Inserta lore persistente manualmente. Con @usuario se asocia a esa persona; sin usuario se guarda como lore del grupo.',
    ),
  },
  facts: {
    category: 'memory',
    usage: l('/facts [@utente]', '/facts [@user]', '/facts [@usuario]'),
    description: l(
      'Mostra la memoria persistente del soggetto. Senza argomento mostra la tua; leggere la memoria di un altro utente richiede admin.',
      'Show durable memory for a subject. With no argument it shows yours; reading another user requires admin authority.',
      'Muestra la memoria persistente del sujeto. Sin argumento muestra la tuya; leer la de otro usuario requiere permisos de admin.',
    ),
  },
  clearfacts: {
    category: 'memory',
    usage: l('/clearfacts [@utente]', '/clearfacts [@user]', '/clearfacts [@usuario]'),
    description: l(
      'Scade/cancella la memoria persistente del soggetto e dimentica anche il relativo profilo sociale. Puoi farlo su te stesso; sugli altri serve admin.',
      'Expire the subject’s durable memory and forget the related social profile too. You can clear yourself; clearing others requires admin.',
      'Caduca/borra la memoria persistente del sujeto y también olvida su perfil social. Puedes hacerlo contigo mismo; para otros hace falta admin.',
    ),
  },
  lore: {
    category: 'memory',
    usage: l('/lore', '/lore', '/lore'),
    description: l(
      'Mostra fino a 5 elementi di lore attiva più rilevanti per il gruppo.',
      'Show up to 5 top active group-lore items.',
      'Muestra hasta 5 elementos principales de lore activa del grupo.',
    ),
  },
  forget: {
    category: 'memory',
    usage: l(
      '/forget (in reply) | /forget <memoryId>',
      '/forget (as reply) | /forget <memoryId>',
      '/forget (en respuesta) | /forget <memoryId>',
    ),
    description: l(
      'In reply dimentica la memoria derivata da quel messaggio; un utente può rimuovere la propria, un admin anche quella altrui. Gli admin possono anche passare un memoryId.',
      'As a reply, forget memory mined from that message; users can remove their own, admins can remove others. Admins may also pass a memoryId directly.',
      'Como respuesta, olvida la memoria extraída de ese mensaje; cada usuario puede borrar la suya y los admins la de otros. Los admins también pueden pasar un memoryId.',
    ),
  },
  conversationtracker: {
    category: 'chat',
    usage: l('/conversationtracker', '/conversationtracker', '/conversationtracker'),
    description: l(
      'Attiva/disattiva il tracking passivo della conversazione usato per contesto e memoria di lavoro della chat.',
      'Toggle passive conversation tracking used for chat context and working memory.',
      'Activa/desactiva el seguimiento pasivo de la conversación usado para contexto y memoria de trabajo.',
    ),
  },
  autoengage: {
    category: 'chat',
    usage: l('/autoengage', '/autoengage', '/autoengage'),
    description: l(
      'Attiva/disattiva le risposte spontanee quando il bot non viene menzionato direttamente; restano soggette alle quote della chat.',
      'Toggle spontaneous replies when the bot is not directly addressed; group quotas still apply.',
      'Activa/desactiva respuestas espontáneas cuando el bot no es mencionado directamente; siguen sujetas a las cuotas del chat.',
    ),
  },
  autopost: {
    category: 'chat',
    usage: l('/autopost', '/autopost', '/autopost'),
    description: l(
      'Attiva/disattiva i post autonomi periodici della chat (news e/o immagini secondo configurazione).',
      'Toggle scheduled autonomous posts for the chat (news and/or images according to configuration).',
      'Activa/desactiva las publicaciones autónomas programadas del chat (noticias y/o imágenes según configuración).',
    ),
  },
  linkmedia: {
    category: 'chat',
    usage: l('/linkmedia', '/linkmedia', '/linkmedia'),
    description: l(
      'Attiva/disattiva il rehost automatico dei link media supportati pubblicati in chat. Non controlla l’archive anime, che ha un percorso separato.',
      'Toggle automatic rehosting of supported media links posted in chat. Anime archive delivery uses a separate path.',
      'Activa/desactiva la resubida automática de enlaces multimedia compatibles publicados en el chat. El archivo de anime usa una ruta separada.',
    ),
  },
  news: {
    category: 'media',
    usage: l('/news', '/news', '/news'),
    description: l(
      'Forza subito un post su una notizia corrente presa dalle fonti RSS configurate, con il commento del bot e il link sorgente.',
      'Force a current-news post now from configured RSS sources, with the bot’s take and source link.',
      'Fuerza ahora una publicación sobre una noticia actual tomada de las fuentes RSS configuradas, con comentario del bot y enlace de origen.',
    ),
  },
  genera: {
    category: 'media',
    usage: l('/genera <prompt>', '/image <prompt>', '/image <prompt>'),
    description: l(
      'Genera un’immagine originale dal prompt usando il planner immagini e il backend disponibile; consuma la quota immagini della chat.',
      'Generate an original image from the prompt using the image planner and available backend; spends the chat image quota.',
      'Genera una imagen original a partir del prompt usando el planificador de imágenes y el backend disponible; consume la cuota de imágenes del chat.',
    ),
  },
  disegna: {
    category: 'media',
    usage: l('/disegna <prompt>', '/draw <prompt>', '/draw <prompt>'),
    description: l(
      'Come /genera, ma forza il profilo/brief manga mantenendo il routing e i controlli media normali.',
      'Like /image, but forces the manga profile/brief while keeping normal media routing and checks.',
      'Como /image, pero fuerza el perfil/brief manga manteniendo el enrutado y los controles multimedia normales.',
    ),
  },
  genvid: {
    category: 'media',
    usage: l('/generavideo <prompt>', '/video <prompt>', '/video <prompt>'),
    description: l(
      'Genera un breve video text-to-video, lo prepara per Telegram e lo invia in chat. È soggetto a quota e rate limit del provider video.',
      'Generate a short text-to-video clip, prepare it for Telegram, and send it to chat. Subject to quota and video-provider rate limits.',
      'Genera un vídeo corto text-to-video, lo prepara para Telegram y lo envía al chat. Está sujeto a cuota y límites del proveedor de vídeo.',
    ),
  },
  nsfw: {
    category: 'administration',
    usage: l('/nsfw [off|base|smart|on]', '/nsfw [off|base|smart|on]', '/nsfw [off|base|smart|on]'),
    description: l(
      'Mostra o cambia il routing NSFW della chat: off disabilita il modello NSFW, base lo usa per tutta la chat, smart decide per messaggio; on è alias di base.',
      'Show or change chat NSFW routing: off disables the NSFW model, base uses it for the whole chat, smart routes per message; on aliases base.',
      'Muestra o cambia el enrutado NSFW del chat: off desactiva el modelo NSFW, base lo usa para todo el chat, smart decide por mensaje; on equivale a base.',
    ),
  },
  ban: {
    category: 'administration',
    usage: l(
      '/ban @utente [secondi] | reply + /ban [secondi]',
      '/ban @user [seconds] | reply + /ban [seconds]',
      '/ban @usuario [segundos] | respuesta + /ban [segundos]',
    ),
    description: l(
      'Bot-admin only. Banna un handle direttamente o l’autore del messaggio citato; la durata è opzionale, 0 significa permanente.',
      'Bot-admin only. Ban a handle directly or the author of the replied message; duration is optional and 0 means permanent.',
      'Solo admin del bot. Banea un usuario directamente o al autor del mensaje citado; la duración es opcional y 0 significa permanente.',
    ),
  },
  unban: {
    category: 'administration',
    usage: l(
      '/unban @utente | reply + /unban',
      '/unban @user | reply + /unban',
      '/unban @usuario | respuesta + /unban',
    ),
    description: l(
      'Bot-admin only. Revoca il ban di un handle indicato o dell’autore del messaggio in reply.',
      'Bot-admin only. Remove the ban for a supplied handle or the author of the replied message.',
      'Solo admin del bot. Quita el ban a un usuario indicado o al autor del mensaje citado.',
    ),
  },
  usage: {
    category: 'diagnostics',
    usage: l('/usage', '/usage', '/usage'),
    description: l(
      'Mostra il consumo personale registrato nel periodo e il relativo limite utente.',
      'Show your recorded usage for the current period and your user limit.',
      'Muestra tu uso registrado en el periodo actual y tu límite de usuario.',
    ),
  },
  language: {
    category: 'chat',
    usage: l('/language', '/language', '/language'),
    description: l(
      'Apre il selettore lingua della chat. Le risposte localizzate seguono la lingua salvata per la chat.',
      'Open the chat-language picker. Localized responses follow the language stored for the chat.',
      'Abre el selector de idioma del chat. Las respuestas localizadas usan el idioma guardado para el chat.',
    ),
  },
  tos: {
    category: 'chat',
    usage: l('/tos | /terms', '/terms | /tos', '/terms | /tos'),
    description: l(
      'Mostra i termini con pulsanti per accettare o revocare. È disponibile anche prima dell’approvazione; il prompt scade dopo circa un minuto.',
      'Show the terms with accept/revoke buttons. Available even before approval; the prompt expires after about one minute.',
      'Muestra los términos con botones para aceptar o revocar. Está disponible incluso antes de la aprobación; el mensaje caduca tras aproximadamente un minuto.',
    ),
  },
  voice: {
    category: 'media',
    usage: l(
      '/voice (in reply o da solo)',
      '/voice (as reply or alone)',
      '/voice (en respuesta o solo)',
    ),
    description: l(
      'Trasforma testo in nota vocale TTS: in reply usa quel messaggio; senza reply usa l’ultimo messaggio disponibile nella chat.',
      'Turn text into a TTS voice note: as a reply it voices that message; alone it uses the latest available chat message.',
      'Convierte texto en nota de voz TTS: como respuesta usa ese mensaje; solo usa el último mensaje disponible del chat.',
    ),
  },
  play: {
    category: 'media',
    usage: l(
      '/play <brano o URL> | reply + /play',
      '/play <track or URL> | reply + /play',
      '/play <canción o URL> | respuesta + /play',
    ),
    description: l(
      'Cerca il brano su YouTube (o usa un URL), estrae l’audio entro il limite configurato e lo invia come nota vocale. Senza argomenti usa il testo citato.',
      'Search YouTube for the track (or use a URL), extract audio within the configured limit, and send a voice note. With no args it uses replied text.',
      'Busca la canción en YouTube (o usa una URL), extrae el audio dentro del límite configurado y lo envía como nota de voz. Sin argumentos usa el texto citado.',
    ),
  },
  sing: {
    category: 'media',
    usage: l(
      '/sing <brano o URL> | reply + /sing',
      '/sing <track or URL> | reply + /sing',
      '/sing <canción o URL> | respuesta + /sing',
    ),
    description: l(
      'Stesso motore di /play, con alias orientati alle richieste musicali/cantate.',
      'Same engine as /play, with aliases phrased for song/singing requests.',
      'Mismo motor que /play, con alias orientados a peticiones de canciones/canto.',
    ),
  },
  translate: {
    category: 'media',
    usage: l(
      '/translate <lingua> (in reply)',
      '/translate <language> (as reply)',
      '/translate <idioma> (en respuesta)',
    ),
    description: l(
      'Traduce il testo del messaggio citato nella lingua richiesta, rilevando automaticamente la lingua sorgente e preservando tono, slang e volgarità.',
      'Translate the replied message into the requested language, auto-detecting the source language while preserving tone, slang, and vulgarity.',
      'Traduce el mensaje citado al idioma pedido, detectando automáticamente el idioma de origen y conservando tono, jerga y vulgaridad.',
    ),
  },
  brain: {
    category: 'administration',
    usage: l('/brain', '/brain', '/brain'),
    description: l(
      'Admin debug: mostra in forma leggibile l’ultimo turno del brain (scene, Cortex, tool, piano, fonti, memoria, stile). Richiede BRAIN_DEBUG_ENABLED.',
      'Admin debug: show a readable summary of the last brain turn (scene, Cortex, tools, plan, sources, memory, style). Requires BRAIN_DEBUG_ENABLED.',
      'Debug de admin: muestra un resumen legible del último turno del brain (scene, Cortex, herramientas, plan, fuentes, memoria y estilo). Requiere BRAIN_DEBUG_ENABLED.',
    ),
  },
  debuglast: {
    category: 'administration',
    usage: l('/debuglast', '/debuglast', '/debuglast'),
    description: l(
      'Admin debug: restituisce un dump JSON compatto dell’ultimo turno del brain, troncato per Telegram. Richiede BRAIN_DEBUG_ENABLED.',
      'Admin debug: return a compact JSON dump of the last brain turn, bounded for Telegram. Requires BRAIN_DEBUG_ENABLED.',
      'Debug de admin: devuelve un volcado JSON compacto del último turno del brain, limitado para Telegram. Requiere BRAIN_DEBUG_ENABLED.',
    ),
  },
  help: {
    category: 'chat',
    usage: l('/help [it|en|es]', '/help [it|en|es]', '/help [it|en|es]'),
    description: l(
      'Mostra il riferimento completo dei comandi registrati. Senza argomento usa IT/EN/ES della chat (altre lingue cadono su EN); it/en/es forza solo la lingua dell’help.',
      'Show the complete registered-command reference. With no argument it follows an IT/EN/ES chat language (other languages fall back to EN); it/en/es overrides only help.',
      'Muestra la referencia completa de comandos registrados. Sin argumento sigue IT/EN/ES del chat (otros idiomas usan EN); it/en/es cambia solo el idioma de la ayuda.',
    ),
  },
  id: {
    category: 'diagnostics',
    usage: l(
      '/id [@utente|telegram-id] oppure reply + /id',
      '/id [@user|telegram-id] or reply + /id',
      '/id [@usuario|telegram-id] o respuesta + /id',
    ),
    description: l(
      'Mostra l’identità Telegram deterministica in YAML: ID numerico raw, username e nome. Senza argomento mostra te stesso; in reply usa l’autore citato. Non usa LLM.',
      'Show deterministic Telegram identity as YAML: raw numeric ID, username, and name. With no argument it shows you; as a reply it targets the replied author. No LLM is used.',
      'Muestra la identidad Telegram determinista en YAML: ID numérico raw, username y nombre. Sin argumento te muestra a ti; como respuesta usa al autor citado. No usa LLM.',
    ),
  },
  admin: {
    category: 'administration',
    usage: l(
      '/admin @utente | reply + /admin',
      '/admin @user | reply + /admin',
      '/admin @usuario | respuesta + /admin',
    ),
    description: l(
      'Bot-admin only. Promuove un utente a bot admin persistendo l’autorità sul Telegram user ID immutabile; username/nome restano solo metadata.',
      'Bot-admin only. Promote a user to bot admin, persisting authority on the immutable Telegram user ID; username/name are metadata only.',
      'Solo admin del bot. Promueve un usuario a admin del bot persistiendo la autoridad sobre el Telegram user ID inmutable; username/nombre son solo metadata.',
    ),
  },
  unadmin: {
    category: 'administration',
    usage: l(
      '/unadmin @utente | reply + /unadmin',
      '/unadmin @user | reply + /unadmin',
      '/unadmin @usuario | respuesta + /unadmin',
    ),
    description: l(
      'Bot-admin only. Revoca una grant runtime basata su Telegram ID. I root admin bootstrap definiti in ADMIN_HANDLES non sono revocabili da Telegram.',
      'Bot-admin only. Revoke a runtime Telegram-ID grant. Bootstrap root admins from ADMIN_HANDLES cannot be revoked from Telegram.',
      'Solo admin del bot. Revoca un permiso runtime basado en Telegram ID. Los root admins bootstrap de ADMIN_HANDLES no pueden revocarse desde Telegram.',
    ),
  },
  admins: {
    category: 'administration',
    usage: l('/admins', '/admins', '/admins'),
    description: l(
      'Bot-admin only. Elenca root admin bootstrap e grant runtime persistite per Telegram user ID.',
      'Bot-admin only. List bootstrap root admins and runtime grants persisted by Telegram user ID.',
      'Solo admin del bot. Lista los root admins bootstrap y los permisos runtime persistidos por Telegram user ID.',
    ),
  },
  approve: {
    category: 'administration',
    usage: l('/approve [id]', '/approve [id]', '/approve [id]'),
    description: l(
      'Bot-admin only. Approva una chat o un utente: ID negativo = chat, positivo = utente; senza ID dentro un gruppo approva la chat corrente.',
      'Bot-admin only. Approve a chat or user: negative ID = chat, positive ID = user; with no ID inside a group it approves the current chat.',
      'Solo admin del bot. Aprueba un chat o usuario: ID negativo = chat, positivo = usuario; sin ID dentro de un grupo aprueba el chat actual.',
    ),
  },
  unapprove: {
    category: 'administration',
    usage: l('/unapprove [id]', '/unapprove [id]', '/unapprove [id]'),
    description: l(
      'Bot-admin only. Revoca un’approvazione usando le stesse regole ID di /approve; senza ID in gruppo agisce sulla chat corrente.',
      'Bot-admin only. Revoke approval using the same ID rules as /approve; with no ID in a group it targets the current chat.',
      'Solo admin del bot. Revoca una aprobación usando las mismas reglas de ID que /approve; sin ID en un grupo actúa sobre el chat actual.',
    ),
  },
  approved: {
    category: 'administration',
    usage: l('/approved', '/approved', '/approved'),
    description: l(
      'Bot-admin only. Elenca chat e utenti approvati e, per le chat, mostra anche stato membership/audit e started/stopped.',
      'Bot-admin only. List approved chats/users and, for chats, membership/audit plus started/stopped state.',
      'Solo admin del bot. Lista chats/usuarios aprobados y, para los chats, estado de membresía/auditoría y started/stopped.',
    ),
  },
  profile: {
    category: 'administration',
    usage: l('/profile [free|plus|pro]', '/profile [free|plus|pro]', '/profile [free|plus|pro]'),
    description: l(
      'Solo gruppi/admin. Senza argomento mostra il piano quote e i contatori; con free, plus o pro cambia il piano della chat.',
      'Groups/admin only. With no argument show quota plan/counters; with free, plus, or pro change the chat plan.',
      'Solo grupos/admin. Sin argumento muestra el plan de cuotas y contadores; con free, plus o pro cambia el plan del chat.',
    ),
  },
  vision: {
    category: 'media',
    usage: l(
      '/vision + foto/video oppure in reply',
      '/vision + photo/video or as reply',
      '/vision + foto/vídeo o en respuesta',
    ),
    description: l(
      'Analizza una foto allegata/citata o un frame estratto da un video e restituisce la descrizione del modello vision.',
      'Analyze an attached/replied photo or a frame extracted from video and return the vision-model description.',
      'Analiza una foto adjunta/citada o un fotograma extraído de un vídeo y devuelve la descripción del modelo de visión.',
    ),
  },
  capabilities: {
    category: 'diagnostics',
    usage: l('/capabilities', '/capabilities', '/capabilities'),
    description: l(
      'Elenca i comandi dinamici/capacità persistenti installati dal Capability Forge, con la loro descrizione.',
      'List persistent dynamic commands/capabilities installed by Capability Forge, with descriptions.',
      'Lista los comandos/capacidades dinámicas persistentes instalados por Capability Forge, con sus descripciones.',
    ),
  },
  learn: {
    category: 'administration',
    usage: l(
      '/learn <richiesta> | status [job] | code <obiettivo> | diff <job> [pagina] | apply <job> <sha12> | cancel <job>',
      '/learn <request> | status [job] | code <goal> | diff <job> [page] | apply <job> <sha12> | cancel <job>',
      '/learn <solicitud> | status [job] | code <objetivo> | diff <job> [página] | apply <job> <sha12> | cancel <job>',
    ),
    description: l(
      'Learn-admin only. Ricerca/installa capacità read-only oppure avvia sviluppo locale revisionabile. I job codice si controllano con status/diff, si applicano solo con hash esplicito e non fanno deploy/restart live.',
      'Learn-admin only. Research/install read-only capabilities or start reviewable local development. Code jobs use status/diff, apply only with an explicit hash, and never deploy/restart live.',
      'Solo learn-admin. Investiga/instala capacidades de solo lectura o inicia desarrollo local revisable. Los jobs de código usan status/diff, se aplican solo con hash explícito y nunca despliegan/reinician producción.',
    ),
  },
  community: {
    category: 'memory',
    usage: l('/community', '/community', '/community'),
    description: l(
      'Mostra una sintesi privacy-safe della memoria sociale: copertura membri attivi, facet, running joke/norme e temi pubblici, senza score relazionali privati.',
      'Show a privacy-safe social-memory summary: active-member coverage, facets, running jokes/norms, and public themes, without private relationship scores.',
      'Muestra un resumen privacy-safe de la memoria social: cobertura de miembros activos, facets, bromas/normas y temas públicos, sin scores relacionales privados.',
    ),
  },
  socialstatus: {
    category: 'administration',
    usage: l('/socialstatus', '/socialstatus', '/socialstatus'),
    description: l(
      'Admin diagnostics della memoria sociale: conteggi e lifecycle di facet, relazioni, joke, norme e versione; non espone i punteggi relazionali privati.',
      'Admin social-memory diagnostics: counts/lifecycle for facets, relationships, jokes, norms, and version; private relationship scores stay hidden.',
      'Diagnóstico admin de memoria social: conteos/lifecycle de facets, relaciones, bromas, normas y versión; los scores relacionales privados permanecen ocultos.',
    ),
  },
  hardware: {
    category: 'diagnostics',
    usage: l(
      '/hardware [cpu|sensori|dischi|tutto]',
      '/hardware [cpu|sensors|disks|all]',
      '/hardware [cpu|sensores|discos|all]',
    ),
    description: l(
      'Mostra dati live allowlisted dell’host: hardware/CPU/RAM/GPU, sensori/temperature/ventole e storage. Nessun segreto o dato arbitrario del filesystem.',
      'Show allowlisted live host facts: hardware/CPU/RAM/GPU, sensors/temperatures/fans, and storage. No secrets or arbitrary filesystem data.',
      'Muestra datos live permitidos del host: hardware/CPU/RAM/GPU, sensores/temperaturas/ventiladores y almacenamiento. Sin secretos ni datos arbitrarios del filesystem.',
    ),
  },
  models: {
    category: 'diagnostics',
    usage: l('/models', '/models', '/models'),
    description: l(
      'Mostra gli identificatori dei modelli configurati per i vari ruoli, senza endpoint, API key o altri segreti.',
      'Show model identifiers configured for the different roles, without endpoints, API keys, or other secrets.',
      'Muestra los identificadores de modelos configurados para los distintos roles, sin endpoints, API keys ni otros secretos.',
    ),
  },
  quota: {
    category: 'diagnostics',
    usage: l('/quota', '/quota', '/quota'),
    description: l(
      'Mostra piano, quote e consumi interni correnti della chat senza spendere un turno conversazionale LLM.',
      'Show the chat’s current plan, internal quotas, and consumption without spending an LLM conversation turn.',
      'Muestra el plan, cuotas internas y consumo actuales del chat sin gastar un turno conversacional LLM.',
    ),
  },
  botinfo: {
    category: 'diagnostics',
    usage: l('/botinfo', '/botinfo', '/botinfo'),
    description: l(
      'Mostra identità pubblica, autore e tecnologia dichiarata del progetto; esclude credenziali ed endpoint operativi sensibili.',
      'Show the project’s public identity, author, and declared technology; operational credentials/endpoints are excluded.',
      'Muestra la identidad pública, autor y tecnología declarada del proyecto; excluye credenciales y endpoints operativos sensibles.',
    ),
  },
  anime: {
    category: 'anime',
    usage: l('/anime <titolo>', '/anime <title>', '/anime <título>'),
    description: l(
      'Interroga il catalogo anime per stato/uscite e prossimo episodio. Non prova che un episodio sia scaricabile: il rehost AnimeUnity/HentaiSaturn è un’action naturale separata.',
      'Query the anime catalog for release status and next episode. It does not prove an episode is downloadable; AnimeUnity/HentaiSaturn rehost is a separate natural-language action.',
      'Consulta el catálogo de anime para estado/estrenos y próximo episodio. No demuestra que un episodio sea descargable; el rehost AnimeUnity/HentaiSaturn es una acción natural separada.',
    ),
  },
  follow: {
    category: 'anime',
    usage: l('/follow <titolo>', '/follow <title>', '/follow <título>'),
    description: l(
      'Segue una serie in questa chat/topic e abilita le notifiche quando un nuovo episodio viene osservato dalle sorgenti supportate.',
      'Follow a series in this chat/topic and enable notifications when a new episode is observed on supported sources.',
      'Sigue una serie en este chat/topic y activa avisos cuando se observa un nuevo episodio en las fuentes compatibles.',
    ),
  },
  unfollow: {
    category: 'anime',
    usage: l('/unfollow <titolo>', '/unfollow <title>', '/unfollow <título>'),
    description: l(
      'Rimuove dalla chat la sottoscrizione alla serie indicata.',
      'Remove this chat’s subscription to the named series.',
      'Elimina del chat la suscripción a la serie indicada.',
    ),
  },
  following: {
    category: 'anime',
    usage: l('/following', '/following', '/following'),
    description: l(
      'Elenca tutte le serie seguite nella chat e, quando disponibile, l’ultimo episodio già notificato.',
      'List all series followed in the chat and, when available, the last episode already notified.',
      'Lista todas las series seguidas en el chat y, cuando está disponible, el último episodio ya notificado.',
    ),
  },
};

const CATEGORY_LABELS: Record<HelpCategory, Localized> = {
  chat: l('Chat e configurazione', 'Chat & configuration', 'Chat y configuración'),
  memory: l('Memoria e community', 'Memory & community', 'Memoria y comunidad'),
  media: l('Media e AI', 'Media & AI', 'Multimedia e IA'),
  anime: l('Anime', 'Anime', 'Anime'),
  diagnostics: l('Stato e diagnostica', 'Status & diagnostics', 'Estado y diagnóstico'),
  administration: l(
    'Amministrazione e sviluppo',
    'Administration & development',
    'Administración y desarrollo',
  ),
};

const ACCESS_LABELS = {
  anyone: l('chiunque', 'anyone', 'cualquiera'),
  approved: l('utente/chat approvata', 'approved user/chat', 'usuario/chat aprobado'),
  admin: l('admin', 'admin', 'admin'),
  botAdmin: l('bot admin', 'bot admin', 'admin del bot'),
  learnAdmin: l('learn admin', 'learn admin', 'learn admin'),
};

export const HELP_CATEGORY_ORDER: readonly HelpCategory[] = [
  'chat',
  'memory',
  'media',
  'anime',
  'diagnostics',
  'administration',
];

export function normalizeHelpLanguage(raw: string | undefined): HelpLanguage | null {
  if (!raw) return null;
  const value = raw.trim().toLocaleLowerCase('it');
  if (['it', 'ita', 'italiano', 'italian'].includes(value)) return 'italian';
  if (['en', 'eng', 'inglese', 'english'].includes(value)) return 'english';
  if (['es', 'esp', 'espanol', 'español', 'spagnolo', 'spanish'].includes(value)) return 'spanish';
  return null;
}

export function helpLanguageForChat(language: string): HelpLanguage {
  return language === 'italian' || language === 'spanish' ? language : 'english';
}

export function categoryLabel(category: HelpCategory, language: HelpLanguage): string {
  return CATEGORY_LABELS[category][language];
}

export function commandAccessLabel(spec: CommandSpec, language: HelpLanguage): string {
  if (spec.permissions.includes('learn_admin')) return ACCESS_LABELS.learnAdmin[language];
  if (spec.permissions.includes('bot_admin')) return ACCESS_LABELS.botAdmin[language];
  if (spec.permissions.includes('admin') || spec.permissions.includes('group_admin')) {
    return ACCESS_LABELS.admin[language];
  }
  if (['help', 'tos'].includes(spec.command)) return ACCESS_LABELS.anyone[language];
  return ACCESS_LABELS.approved[language];
}

export function helpDefinition(command: string): CommandHelpDefinition | undefined {
  return COMMAND_HELP[command];
}
