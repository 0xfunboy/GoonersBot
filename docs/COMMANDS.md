# GoonersBot command reference

> GENERATED FILE — update `src/telegram/handlers/commands/helpCatalog.ts` or the command registry, then run `pnpm docs:commands`.

Static commands: **54**. Capability Forge may install additional dynamic commands at runtime; use `/capabilities` to list those currently installed.

Access model: `admin` means group administrator **or** bot admin; `bot admin` means either a bootstrap/root handle from `ADMIN_HANDLES` or a runtime grant persisted by immutable Telegram user ID; `learn admin` means bot admin or an immutable local-development admin ID. Except for `/start`, `/tos`/`/terms`, and `/help`, commands also pass through the approval gate.

Anime note: `/anime` is the release/catalog command. AnimeUnity/HentaiSaturn availability, single-episode rehost, and current-season bulk rehost are natural-language `anime_archive` actions rather than separate slash commands. Archive delivery preserves the source and enforces one episode = one Telegram file.

## Italiano

Riferimento completo dei comandi statici registrati da GoonersBot. Le sintassi e gli alias qui sotto sono generati dalla stessa codebase usata dal runtime.

### Chat e configurazione

#### `/start`

Riattiva GoonersBot nella chat. Richiede un admin della chat o un bot admin configurato.

- **Accesso:** admin
- **Alias registrati:** `/avvia`

#### `/stop`

Mette GoonersBot in stato stopped nella chat; i normali turni non vengono più gestiti finché non usi /start.

- **Accesso:** admin
- **Alias registrati:** `/ferma`

#### `/addmode <descrizione>`

Crea una modalità custom per questa chat; il nome viene derivato dalla prima frase della descrizione.

- **Accesso:** admin
- **Alias registrati:** `/aggiungimodalita`

#### `/autoengage`

Attiva/disattiva le risposte spontanee quando il bot non viene menzionato direttamente; restano soggette alle quote della chat.

- **Accesso:** admin
- **Alias registrati:** `/autointerventi`

#### `/autopost`

Attiva/disattiva i post autonomi periodici della chat (news e/o immagini secondo configurazione).

- **Accesso:** admin
- **Alias registrati:** `/autopubblica`

#### `/conversationtracker`

Attiva/disattiva il tracking passivo della conversazione usato per contesto e memoria di lavoro della chat.

- **Accesso:** admin
- **Alias registrati:** `/tracciaconversazione`

#### `/deletemode`

Apre la tastiera delle modalità della chat che possono essere eliminate.

- **Accesso:** admin
- **Alias registrati:** `/eliminamodalita`

#### `/language`

Apre il selettore lingua della chat. Le risposte localizzate seguono la lingua salvata per la chat.

- **Accesso:** admin
- **Alias registrati:** `/lingua`

#### `/linkmedia`

Attiva/disattiva il rehost automatico dei link media supportati pubblicati in chat. Non controlla l’archive anime, che ha un percorso separato.

- **Accesso:** admin
- **Alias registrati:** `/medialink`

#### `/mode`

Apre la tastiera delle modalità disponibili e imposta il comportamento/persona della chat.

- **Accesso:** admin
- **Alias registrati:** `/modalita`

#### `/reset`

Azzera la memoria della conversazione corrente. Non cancella lore/fatti persistenti: per quelli usa /clearfacts o /forget.

- **Accesso:** admin
- **Alias registrati:** `/reimposta`

#### `/tos | /terms`

Mostra i termini con pulsanti per accettare o revocare. È disponibile anche prima dell’approvazione; il prompt scade dopo circa un minuto.

- **Accesso:** chiunque
- **Alias registrati:** `/terms`, `/termini`

#### `/help [it|en|es]`

Mostra il riferimento completo dei comandi registrati. Senza argomento usa IT/EN/ES della chat (altre lingue cadono su EN); it/en/es forza solo la lingua dell’help.

- **Accesso:** chiunque
- **Alias registrati:** `/aiuto`

### Memoria e community

#### `/clearfacts [@utente]`

Scade/cancella la memoria persistente del soggetto e dimentica anche il relativo profilo sociale. Puoi farlo su te stesso; sugli altri serve admin.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/cancellafatti`

#### `/facts [@utente]`

Mostra la memoria persistente del soggetto. Senza argomento mostra la tua; leggere la memoria di un altro utente richiede admin.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/fatti`, `/memory`, `/memoria`

#### `/forget (in reply) | /forget <memoryId>`

In reply dimentica la memoria derivata da quel messaggio; un utente può rimuovere la propria, un admin anche quella altrui. Gli admin possono anche passare un memoryId.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/dimentica`

#### `/introduce <chi sei>`

Salva una tua auto-presentazione come lore durevole di tipo ruolo, attribuita al tuo handle.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/presentati`

#### `/lore`

Mostra fino a 5 elementi di lore attiva più rilevanti per il gruppo.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/storia`

#### `/community`

Mostra una sintesi privacy-safe della memoria sociale: copertura membri attivi, facet, running joke/norme e temi pubblici, senza score relazionali privati.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/social`, `/comunita`

### Media e AI

#### `/disegna <prompt>`

Come /genera, ma forza il profilo/brief manga mantenendo il routing e i controlli media normali.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/draw`, `/sketch`

#### `/genera <prompt>`

Genera un’immagine originale dal prompt usando il planner immagini e il backend disponibile; consuma la quota immagini della chat.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/image`, `/img`, `/generate`

#### `/generavideo <prompt>`

Genera un breve video text-to-video, lo prepara per Telegram e lo invia in chat. È soggetto a quota e rate limit del provider video.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/video`, `/genvideo`, `/generavideo`, `/vid`, `/clip`, `/animazione`, `/genclip`

#### `/news`

Forza subito un post su una notizia corrente presa dalle fonti RSS configurate, con il commento del bot e il link sorgente.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/nuovo`, `/notizie`

#### `/play <brano o URL> | reply + /play`

Cerca il brano su YouTube (o usa un URL), estrae l’audio entro il limite configurato e lo invia come nota vocale. Senza argomenti usa il testo citato.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/suona`, `/riproduci`, `/reproduce`

#### `/sing <brano o URL> | reply + /sing`

Stesso motore di /play, con alias orientati alle richieste musicali/cantate.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/canta`, `/cantami`, `/cantame`

#### `/translate <lingua> (in reply)`

Traduce il testo del messaggio citato nella lingua richiesta, rilevando automaticamente la lingua sorgente e preservando tono, slang e volgarità.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/traduci`

#### `/vision + foto/video oppure in reply`

Analizza una foto allegata/citata o un frame estratto da un video e restituisce la descrizione del modello vision.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/visione`

#### `/voice (in reply o da solo)`

Trasforma testo in nota vocale TTS: in reply usa quel messaggio; senza reply usa l’ultimo messaggio disponibile nella chat.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/voce`

### Anime

#### `/anime <titolo>`

Interroga il catalogo anime per stato/uscite e prossimo episodio. Non prova che un episodio sia scaricabile: il rehost AnimeUnity/HentaiSaturn è un’action naturale separata.

- **Accesso:** utente/chat approvata
- **Alias registrati:** —

#### `/follow <titolo>`

Segue una serie in questa chat/topic e abilita le notifiche quando un nuovo episodio viene osservato dalle sorgenti supportate.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/segui`

#### `/following`

Elenca tutte le serie seguite nella chat e, quando disponibile, l’ultimo episodio già notificato.

- **Accesso:** utente/chat approvata
- **Alias registrati:** —

#### `/unfollow <titolo>`

Rimuove dalla chat la sottoscrizione alla serie indicata.

- **Accesso:** utente/chat approvata
- **Alias registrati:** —

### Stato e diagnostica

#### `/botinfo`

Mostra identità pubblica, autore e tecnologia dichiarata del progetto; esclude credenziali ed endpoint operativi sensibili.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/aboutbot`, `/infobot`

#### `/capabilities`

Elenca i comandi dinamici/capacità persistenti installati dal Capability Forge, con la loro descrizione.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/skills`, `/capacita`

#### `/hardware [cpu|sensori|dischi|tutto]`

Mostra dati live allowlisted dell’host: hardware/CPU/RAM/GPU, sensori/temperature/ventole e storage. Nessun segreto o dato arbitrario del filesystem.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/systeminfo`, `/sysinfo`, `/specs`, `/sistema`

#### `/id [@utente|telegram-id] oppure reply + /id`

Mostra l’identità Telegram deterministica in YAML: ID numerico raw, username e nome. Senza argomento mostra te stesso; in reply usa l’autore citato. Non usa LLM.

- **Accesso:** utente/chat approvata
- **Alias registrati:** —

#### `/models`

Mostra gli identificatori dei modelli configurati per i vari ruoli, senza endpoint, API key o altri segreti.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/modelli`

#### `/quota`

Mostra piano, quote e consumi interni correnti della chat senza spendere un turno conversazionale LLM.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/quotas`, `/quote`

#### `/usage`

Mostra il consumo personale registrato nel periodo e il relativo limite utente.

- **Accesso:** utente/chat approvata
- **Alias registrati:** `/utilizzo`

### Amministrazione e sviluppo

#### `/admin @utente | reply + /admin`

Bot-admin only. Promuove un utente a bot admin persistendo l’autorità sul Telegram user ID immutabile; username/nome restano solo metadata.

- **Accesso:** bot admin
- **Alias registrati:** —

#### `/admins`

Bot-admin only. Elenca root admin bootstrap e grant runtime persistite per Telegram user ID.

- **Accesso:** bot admin
- **Alias registrati:** —

#### `/approve [id]`

Bot-admin only. Approva una chat o un utente: ID negativo = chat, positivo = utente; senza ID dentro un gruppo approva la chat corrente.

- **Accesso:** bot admin
- **Alias registrati:** `/approva`

#### `/approved`

Bot-admin only. Elenca chat e utenti approvati e, per le chat, mostra anche stato membership/audit e started/stopped.

- **Accesso:** bot admin
- **Alias registrati:** `/approvati`

#### `/ban @utente [secondi] | reply + /ban [secondi]`

Bot-admin only. Banna un handle direttamente o l’autore del messaggio citato; la durata è opzionale, 0 significa permanente.

- **Accesso:** bot admin
- **Alias registrati:** `/banna`

#### `/brain`

Admin debug: mostra in forma leggibile l’ultimo turno del brain (scene, Cortex, tool, piano, fonti, memoria, stile). Richiede BRAIN_DEBUG_ENABLED.

- **Accesso:** admin
- **Alias registrati:** `/cervello`

#### `/debuglast`

Admin debug: restituisce un dump JSON compatto dell’ultimo turno del brain, troncato per Telegram. Richiede BRAIN_DEBUG_ENABLED.

- **Accesso:** admin
- **Alias registrati:** `/debugultimo`

#### `/learn <richiesta> | status [job] | code <obiettivo> | diff <job> [pagina] | apply <job> <sha12> | cancel <job>`

Learn-admin only. Ricerca/installa capacità read-only oppure avvia sviluppo locale revisionabile. I job codice si controllano con status/diff, si applicano solo con hash esplicito e non fanno deploy/restart live.

- **Accesso:** learn admin
- **Alias registrati:** `/impara`

#### `/nsfw [off|base|smart|on]`

Mostra o cambia il routing NSFW della chat: off disabilita il modello NSFW, base lo usa per tutta la chat, smart decide per messaggio; on è alias di base.

- **Accesso:** admin
- **Alias registrati:** —

#### `/profile [free|plus|pro]`

Solo gruppi/admin. Senza argomento mostra il piano quote e i contatori; con free, plus o pro cambia il piano della chat.

- **Accesso:** admin
- **Alias registrati:** `/plan`, `/piano`, `/groupplan`, `/groupquota`, `/profilo`

#### `/setfact [@utente] <fatto/lore>`

Inserisce manualmente lore persistente. Con @utente la associa a quella persona; senza handle la salva come lore del gruppo.

- **Accesso:** admin
- **Alias registrati:** `/impostafatto`, `/remember`, `/ricorda`

#### `/socialstatus`

Admin diagnostics della memoria sociale: conteggi e lifecycle di facet, relazioni, joke, norme e versione; non espone i punteggi relazionali privati.

- **Accesso:** admin
- **Alias registrati:** `/communitystatus`, `/statosociale`

#### `/unadmin @utente | reply + /unadmin`

Bot-admin only. Revoca una grant runtime basata su Telegram ID. I root admin bootstrap definiti in ADMIN_HANDLES non sono revocabili da Telegram.

- **Accesso:** bot admin
- **Alias registrati:** —

#### `/unapprove [id]`

Bot-admin only. Revoca un’approvazione usando le stesse regole ID di /approve; senza ID in gruppo agisce sulla chat corrente.

- **Accesso:** bot admin
- **Alias registrati:** `/disapprova`

#### `/unban @utente | reply + /unban`

Bot-admin only. Revoca il ban di un handle indicato o dell’autore del messaggio in reply.

- **Accesso:** bot admin
- **Alias registrati:** `/sbanna`

## English

Complete reference for the static commands registered by GoonersBot. Syntax and aliases below are generated from the same codebase used at runtime.

### Chat & configuration

#### `/start`

Wake GoonersBot in the current chat. Requires a group admin or configured bot admin.

- **Access:** admin
- **Registered aliases:** `/avvia`

#### `/stop`

Put GoonersBot in the stopped state for this chat; normal turns stay disabled until /start.

- **Access:** admin
- **Registered aliases:** `/ferma`

#### `/addmode <description>`

Create a custom mode for this chat; its name is derived from the first sentence of the description.

- **Access:** admin
- **Registered aliases:** `/aggiungimodalita`

#### `/autoengage`

Toggle spontaneous replies when the bot is not directly addressed; group quotas still apply.

- **Access:** admin
- **Registered aliases:** `/autointerventi`

#### `/autopost`

Toggle scheduled autonomous posts for the chat (news and/or images according to configuration).

- **Access:** admin
- **Registered aliases:** `/autopubblica`

#### `/conversationtracker`

Toggle passive conversation tracking used for chat context and working memory.

- **Access:** admin
- **Registered aliases:** `/tracciaconversazione`

#### `/deletemode`

Open the keyboard of chat modes that can be deleted.

- **Access:** admin
- **Registered aliases:** `/eliminamodalita`

#### `/language`

Open the chat-language picker. Localized responses follow the language stored for the chat.

- **Access:** admin
- **Registered aliases:** `/lingua`

#### `/linkmedia`

Toggle automatic rehosting of supported media links posted in chat. Anime archive delivery uses a separate path.

- **Access:** admin
- **Registered aliases:** `/medialink`

#### `/mode`

Open the available-mode keyboard and select the chat behavior/persona.

- **Access:** admin
- **Registered aliases:** `/modalita`

#### `/reset`

Reset the current conversation memory. It does not erase durable lore/facts; use /clearfacts or /forget for those.

- **Access:** admin
- **Registered aliases:** `/reimposta`

#### `/terms | /tos`

Show the terms with accept/revoke buttons. Available even before approval; the prompt expires after about one minute.

- **Access:** anyone
- **Registered aliases:** `/terms`, `/termini`

#### `/help [it|en|es]`

Show the complete registered-command reference. With no argument it follows an IT/EN/ES chat language (other languages fall back to EN); it/en/es overrides only help.

- **Access:** anyone
- **Registered aliases:** `/aiuto`

### Memory & community

#### `/clearfacts [@user]`

Expire the subject’s durable memory and forget the related social profile too. You can clear yourself; clearing others requires admin.

- **Access:** approved user/chat
- **Registered aliases:** `/cancellafatti`

#### `/facts [@user]`

Show durable memory for a subject. With no argument it shows yours; reading another user requires admin authority.

- **Access:** approved user/chat
- **Registered aliases:** `/fatti`, `/memory`, `/memoria`

#### `/forget (as reply) | /forget <memoryId>`

As a reply, forget memory mined from that message; users can remove their own, admins can remove others. Admins may also pass a memoryId directly.

- **Access:** approved user/chat
- **Registered aliases:** `/dimentica`

#### `/introduce <who you are>`

Store your self-introduction as durable role lore attached to your handle.

- **Access:** approved user/chat
- **Registered aliases:** `/presentati`

#### `/lore`

Show up to 5 top active group-lore items.

- **Access:** approved user/chat
- **Registered aliases:** `/storia`

#### `/community`

Show a privacy-safe social-memory summary: active-member coverage, facets, running jokes/norms, and public themes, without private relationship scores.

- **Access:** approved user/chat
- **Registered aliases:** `/social`, `/comunita`

### Media & AI

#### `/draw <prompt>`

Like /image, but forces the manga profile/brief while keeping normal media routing and checks.

- **Access:** approved user/chat
- **Registered aliases:** `/draw`, `/sketch`

#### `/image <prompt>`

Generate an original image from the prompt using the image planner and available backend; spends the chat image quota.

- **Access:** approved user/chat
- **Registered aliases:** `/image`, `/img`, `/generate`

#### `/video <prompt>`

Generate a short text-to-video clip, prepare it for Telegram, and send it to chat. Subject to quota and video-provider rate limits.

- **Access:** approved user/chat
- **Registered aliases:** `/video`, `/genvideo`, `/generavideo`, `/vid`, `/clip`, `/animazione`, `/genclip`

#### `/news`

Force a current-news post now from configured RSS sources, with the bot’s take and source link.

- **Access:** approved user/chat
- **Registered aliases:** `/nuovo`, `/notizie`

#### `/play <track or URL> | reply + /play`

Search YouTube for the track (or use a URL), extract audio within the configured limit, and send a voice note. With no args it uses replied text.

- **Access:** approved user/chat
- **Registered aliases:** `/suona`, `/riproduci`, `/reproduce`

#### `/sing <track or URL> | reply + /sing`

Same engine as /play, with aliases phrased for song/singing requests.

- **Access:** approved user/chat
- **Registered aliases:** `/canta`, `/cantami`, `/cantame`

#### `/translate <language> (as reply)`

Translate the replied message into the requested language, auto-detecting the source language while preserving tone, slang, and vulgarity.

- **Access:** approved user/chat
- **Registered aliases:** `/traduci`

#### `/vision + photo/video or as reply`

Analyze an attached/replied photo or a frame extracted from video and return the vision-model description.

- **Access:** approved user/chat
- **Registered aliases:** `/visione`

#### `/voice (as reply or alone)`

Turn text into a TTS voice note: as a reply it voices that message; alone it uses the latest available chat message.

- **Access:** approved user/chat
- **Registered aliases:** `/voce`

### Anime

#### `/anime <title>`

Query the anime catalog for release status and next episode. It does not prove an episode is downloadable; AnimeUnity/HentaiSaturn rehost is a separate natural-language action.

- **Access:** approved user/chat
- **Registered aliases:** —

#### `/follow <title>`

Follow a series in this chat/topic and enable notifications when a new episode is observed on supported sources.

- **Access:** approved user/chat
- **Registered aliases:** `/segui`

#### `/following`

List all series followed in the chat and, when available, the last episode already notified.

- **Access:** approved user/chat
- **Registered aliases:** —

#### `/unfollow <title>`

Remove this chat’s subscription to the named series.

- **Access:** approved user/chat
- **Registered aliases:** —

### Status & diagnostics

#### `/botinfo`

Show the project’s public identity, author, and declared technology; operational credentials/endpoints are excluded.

- **Access:** approved user/chat
- **Registered aliases:** `/aboutbot`, `/infobot`

#### `/capabilities`

List persistent dynamic commands/capabilities installed by Capability Forge, with descriptions.

- **Access:** approved user/chat
- **Registered aliases:** `/skills`, `/capacita`

#### `/hardware [cpu|sensors|disks|all]`

Show allowlisted live host facts: hardware/CPU/RAM/GPU, sensors/temperatures/fans, and storage. No secrets or arbitrary filesystem data.

- **Access:** approved user/chat
- **Registered aliases:** `/systeminfo`, `/sysinfo`, `/specs`, `/sistema`

#### `/id [@user|telegram-id] or reply + /id`

Show deterministic Telegram identity as YAML: raw numeric ID, username, and name. With no argument it shows you; as a reply it targets the replied author. No LLM is used.

- **Access:** approved user/chat
- **Registered aliases:** —

#### `/models`

Show model identifiers configured for the different roles, without endpoints, API keys, or other secrets.

- **Access:** approved user/chat
- **Registered aliases:** `/modelli`

#### `/quota`

Show the chat’s current plan, internal quotas, and consumption without spending an LLM conversation turn.

- **Access:** approved user/chat
- **Registered aliases:** `/quotas`, `/quote`

#### `/usage`

Show your recorded usage for the current period and your user limit.

- **Access:** approved user/chat
- **Registered aliases:** `/utilizzo`

### Administration & development

#### `/admin @user | reply + /admin`

Bot-admin only. Promote a user to bot admin, persisting authority on the immutable Telegram user ID; username/name are metadata only.

- **Access:** bot admin
- **Registered aliases:** —

#### `/admins`

Bot-admin only. List bootstrap root admins and runtime grants persisted by Telegram user ID.

- **Access:** bot admin
- **Registered aliases:** —

#### `/approve [id]`

Bot-admin only. Approve a chat or user: negative ID = chat, positive ID = user; with no ID inside a group it approves the current chat.

- **Access:** bot admin
- **Registered aliases:** `/approva`

#### `/approved`

Bot-admin only. List approved chats/users and, for chats, membership/audit plus started/stopped state.

- **Access:** bot admin
- **Registered aliases:** `/approvati`

#### `/ban @user [seconds] | reply + /ban [seconds]`

Bot-admin only. Ban a handle directly or the author of the replied message; duration is optional and 0 means permanent.

- **Access:** bot admin
- **Registered aliases:** `/banna`

#### `/brain`

Admin debug: show a readable summary of the last brain turn (scene, Cortex, tools, plan, sources, memory, style). Requires BRAIN_DEBUG_ENABLED.

- **Access:** admin
- **Registered aliases:** `/cervello`

#### `/debuglast`

Admin debug: return a compact JSON dump of the last brain turn, bounded for Telegram. Requires BRAIN_DEBUG_ENABLED.

- **Access:** admin
- **Registered aliases:** `/debugultimo`

#### `/learn <request> | status [job] | code <goal> | diff <job> [page] | apply <job> <sha12> | cancel <job>`

Learn-admin only. Research/install read-only capabilities or start reviewable local development. Code jobs use status/diff, apply only with an explicit hash, and never deploy/restart live.

- **Access:** learn admin
- **Registered aliases:** `/impara`

#### `/nsfw [off|base|smart|on]`

Show or change chat NSFW routing: off disables the NSFW model, base uses it for the whole chat, smart routes per message; on aliases base.

- **Access:** admin
- **Registered aliases:** —

#### `/profile [free|plus|pro]`

Groups/admin only. With no argument show quota plan/counters; with free, plus, or pro change the chat plan.

- **Access:** admin
- **Registered aliases:** `/plan`, `/piano`, `/groupplan`, `/groupquota`, `/profilo`

#### `/setfact [@user] <fact/lore>`

Manually insert durable lore. With @user it targets that person; without a handle it becomes group lore.

- **Access:** admin
- **Registered aliases:** `/impostafatto`, `/remember`, `/ricorda`

#### `/socialstatus`

Admin social-memory diagnostics: counts/lifecycle for facets, relationships, jokes, norms, and version; private relationship scores stay hidden.

- **Access:** admin
- **Registered aliases:** `/communitystatus`, `/statosociale`

#### `/unadmin @user | reply + /unadmin`

Bot-admin only. Revoke a runtime Telegram-ID grant. Bootstrap root admins from ADMIN_HANDLES cannot be revoked from Telegram.

- **Access:** bot admin
- **Registered aliases:** —

#### `/unapprove [id]`

Bot-admin only. Revoke approval using the same ID rules as /approve; with no ID in a group it targets the current chat.

- **Access:** bot admin
- **Registered aliases:** `/disapprova`

#### `/unban @user | reply + /unban`

Bot-admin only. Remove the ban for a supplied handle or the author of the replied message.

- **Access:** bot admin
- **Registered aliases:** `/sbanna`

## Español

Referencia completa de los comandos estáticos registrados por GoonersBot. La sintaxis y los alias se generan desde la misma codebase usada en runtime.

### Chat y configuración

#### `/start`

Reactiva GoonersBot en el chat actual. Requiere un admin del grupo o un admin del bot configurado.

- **Acceso:** admin
- **Alias registrados:** `/avvia`

#### `/stop`

Pone GoonersBot en estado stopped para este chat; los turnos normales quedan desactivados hasta /start.

- **Acceso:** admin
- **Alias registrados:** `/ferma`

#### `/addmode <descripción>`

Crea un modo personalizado para este chat; el nombre se deriva de la primera frase de la descripción.

- **Acceso:** admin
- **Alias registrados:** `/aggiungimodalita`

#### `/autoengage`

Activa/desactiva respuestas espontáneas cuando el bot no es mencionado directamente; siguen sujetas a las cuotas del chat.

- **Acceso:** admin
- **Alias registrados:** `/autointerventi`

#### `/autopost`

Activa/desactiva las publicaciones autónomas programadas del chat (noticias y/o imágenes según configuración).

- **Acceso:** admin
- **Alias registrados:** `/autopubblica`

#### `/conversationtracker`

Activa/desactiva el seguimiento pasivo de la conversación usado para contexto y memoria de trabajo.

- **Acceso:** admin
- **Alias registrados:** `/tracciaconversazione`

#### `/deletemode`

Abre el teclado de modos del chat que se pueden eliminar.

- **Acceso:** admin
- **Alias registrados:** `/eliminamodalita`

#### `/language`

Abre el selector de idioma del chat. Las respuestas localizadas usan el idioma guardado para el chat.

- **Acceso:** admin
- **Alias registrados:** `/lingua`

#### `/linkmedia`

Activa/desactiva la resubida automática de enlaces multimedia compatibles publicados en el chat. El archivo de anime usa una ruta separada.

- **Acceso:** admin
- **Alias registrados:** `/medialink`

#### `/mode`

Abre el teclado de modos disponibles y selecciona el comportamiento/persona del chat.

- **Acceso:** admin
- **Alias registrados:** `/modalita`

#### `/reset`

Reinicia la memoria de la conversación actual. No borra lore/datos persistentes; usa /clearfacts o /forget para eso.

- **Acceso:** admin
- **Alias registrados:** `/reimposta`

#### `/terms | /tos`

Muestra los términos con botones para aceptar o revocar. Está disponible incluso antes de la aprobación; el mensaje caduca tras aproximadamente un minuto.

- **Acceso:** cualquiera
- **Alias registrados:** `/terms`, `/termini`

#### `/help [it|en|es]`

Muestra la referencia completa de comandos registrados. Sin argumento sigue IT/EN/ES del chat (otros idiomas usan EN); it/en/es cambia solo el idioma de la ayuda.

- **Acceso:** cualquiera
- **Alias registrados:** `/aiuto`

### Memoria y comunidad

#### `/clearfacts [@usuario]`

Caduca/borra la memoria persistente del sujeto y también olvida su perfil social. Puedes hacerlo contigo mismo; para otros hace falta admin.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/cancellafatti`

#### `/facts [@usuario]`

Muestra la memoria persistente del sujeto. Sin argumento muestra la tuya; leer la de otro usuario requiere permisos de admin.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/fatti`, `/memory`, `/memoria`

#### `/forget (en respuesta) | /forget <memoryId>`

Como respuesta, olvida la memoria extraída de ese mensaje; cada usuario puede borrar la suya y los admins la de otros. Los admins también pueden pasar un memoryId.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/dimentica`

#### `/introduce <quién eres>`

Guarda tu presentación personal como lore persistente de tipo rol asociada a tu usuario.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/presentati`

#### `/lore`

Muestra hasta 5 elementos principales de lore activa del grupo.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/storia`

#### `/community`

Muestra un resumen privacy-safe de la memoria social: cobertura de miembros activos, facets, bromas/normas y temas públicos, sin scores relacionales privados.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/social`, `/comunita`

### Multimedia e IA

#### `/draw <prompt>`

Como /image, pero fuerza el perfil/brief manga manteniendo el enrutado y los controles multimedia normales.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/draw`, `/sketch`

#### `/image <prompt>`

Genera una imagen original a partir del prompt usando el planificador de imágenes y el backend disponible; consume la cuota de imágenes del chat.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/image`, `/img`, `/generate`

#### `/video <prompt>`

Genera un vídeo corto text-to-video, lo prepara para Telegram y lo envía al chat. Está sujeto a cuota y límites del proveedor de vídeo.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/video`, `/genvideo`, `/generavideo`, `/vid`, `/clip`, `/animazione`, `/genclip`

#### `/news`

Fuerza ahora una publicación sobre una noticia actual tomada de las fuentes RSS configuradas, con comentario del bot y enlace de origen.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/nuovo`, `/notizie`

#### `/play <canción o URL> | respuesta + /play`

Busca la canción en YouTube (o usa una URL), extrae el audio dentro del límite configurado y lo envía como nota de voz. Sin argumentos usa el texto citado.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/suona`, `/riproduci`, `/reproduce`

#### `/sing <canción o URL> | respuesta + /sing`

Mismo motor que /play, con alias orientados a peticiones de canciones/canto.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/canta`, `/cantami`, `/cantame`

#### `/translate <idioma> (en respuesta)`

Traduce el mensaje citado al idioma pedido, detectando automáticamente el idioma de origen y conservando tono, jerga y vulgaridad.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/traduci`

#### `/vision + foto/vídeo o en respuesta`

Analiza una foto adjunta/citada o un fotograma extraído de un vídeo y devuelve la descripción del modelo de visión.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/visione`

#### `/voice (en respuesta o solo)`

Convierte texto en nota de voz TTS: como respuesta usa ese mensaje; solo usa el último mensaje disponible del chat.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/voce`

### Anime

#### `/anime <título>`

Consulta el catálogo de anime para estado/estrenos y próximo episodio. No demuestra que un episodio sea descargable; el rehost AnimeUnity/HentaiSaturn es una acción natural separada.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** —

#### `/follow <título>`

Sigue una serie en este chat/topic y activa avisos cuando se observa un nuevo episodio en las fuentes compatibles.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/segui`

#### `/following`

Lista todas las series seguidas en el chat y, cuando está disponible, el último episodio ya notificado.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** —

#### `/unfollow <título>`

Elimina del chat la suscripción a la serie indicada.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** —

### Estado y diagnóstico

#### `/botinfo`

Muestra la identidad pública, autor y tecnología declarada del proyecto; excluye credenciales y endpoints operativos sensibles.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/aboutbot`, `/infobot`

#### `/capabilities`

Lista los comandos/capacidades dinámicas persistentes instalados por Capability Forge, con sus descripciones.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/skills`, `/capacita`

#### `/hardware [cpu|sensores|discos|all]`

Muestra datos live permitidos del host: hardware/CPU/RAM/GPU, sensores/temperaturas/ventiladores y almacenamiento. Sin secretos ni datos arbitrarios del filesystem.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/systeminfo`, `/sysinfo`, `/specs`, `/sistema`

#### `/id [@usuario|telegram-id] o respuesta + /id`

Muestra la identidad Telegram determinista en YAML: ID numérico raw, username y nombre. Sin argumento te muestra a ti; como respuesta usa al autor citado. No usa LLM.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** —

#### `/models`

Muestra los identificadores de modelos configurados para los distintos roles, sin endpoints, API keys ni otros secretos.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/modelli`

#### `/quota`

Muestra el plan, cuotas internas y consumo actuales del chat sin gastar un turno conversacional LLM.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/quotas`, `/quote`

#### `/usage`

Muestra tu uso registrado en el periodo actual y tu límite de usuario.

- **Acceso:** usuario/chat aprobado
- **Alias registrados:** `/utilizzo`

### Administración y desarrollo

#### `/admin @usuario | respuesta + /admin`

Solo admin del bot. Promueve un usuario a admin del bot persistiendo la autoridad sobre el Telegram user ID inmutable; username/nombre son solo metadata.

- **Acceso:** admin del bot
- **Alias registrados:** —

#### `/admins`

Solo admin del bot. Lista los root admins bootstrap y los permisos runtime persistidos por Telegram user ID.

- **Acceso:** admin del bot
- **Alias registrados:** —

#### `/approve [id]`

Solo admin del bot. Aprueba un chat o usuario: ID negativo = chat, positivo = usuario; sin ID dentro de un grupo aprueba el chat actual.

- **Acceso:** admin del bot
- **Alias registrados:** `/approva`

#### `/approved`

Solo admin del bot. Lista chats/usuarios aprobados y, para los chats, estado de membresía/auditoría y started/stopped.

- **Acceso:** admin del bot
- **Alias registrados:** `/approvati`

#### `/ban @usuario [segundos] | respuesta + /ban [segundos]`

Solo admin del bot. Banea un usuario directamente o al autor del mensaje citado; la duración es opcional y 0 significa permanente.

- **Acceso:** admin del bot
- **Alias registrados:** `/banna`

#### `/brain`

Debug de admin: muestra un resumen legible del último turno del brain (scene, Cortex, herramientas, plan, fuentes, memoria y estilo). Requiere BRAIN_DEBUG_ENABLED.

- **Acceso:** admin
- **Alias registrados:** `/cervello`

#### `/debuglast`

Debug de admin: devuelve un volcado JSON compacto del último turno del brain, limitado para Telegram. Requiere BRAIN_DEBUG_ENABLED.

- **Acceso:** admin
- **Alias registrados:** `/debugultimo`

#### `/learn <solicitud> | status [job] | code <objetivo> | diff <job> [página] | apply <job> <sha12> | cancel <job>`

Solo learn-admin. Investiga/instala capacidades de solo lectura o inicia desarrollo local revisable. Los jobs de código usan status/diff, se aplican solo con hash explícito y nunca despliegan/reinician producción.

- **Acceso:** learn admin
- **Alias registrados:** `/impara`

#### `/nsfw [off|base|smart|on]`

Muestra o cambia el enrutado NSFW del chat: off desactiva el modelo NSFW, base lo usa para todo el chat, smart decide por mensaje; on equivale a base.

- **Acceso:** admin
- **Alias registrados:** —

#### `/profile [free|plus|pro]`

Solo grupos/admin. Sin argumento muestra el plan de cuotas y contadores; con free, plus o pro cambia el plan del chat.

- **Acceso:** admin
- **Alias registrados:** `/plan`, `/piano`, `/groupplan`, `/groupquota`, `/profilo`

#### `/setfact [@usuario] <dato/lore>`

Inserta lore persistente manualmente. Con @usuario se asocia a esa persona; sin usuario se guarda como lore del grupo.

- **Acceso:** admin
- **Alias registrados:** `/impostafatto`, `/remember`, `/ricorda`

#### `/socialstatus`

Diagnóstico admin de memoria social: conteos/lifecycle de facets, relaciones, bromas, normas y versión; los scores relacionales privados permanecen ocultos.

- **Acceso:** admin
- **Alias registrados:** `/communitystatus`, `/statosociale`

#### `/unadmin @usuario | respuesta + /unadmin`

Solo admin del bot. Revoca un permiso runtime basado en Telegram ID. Los root admins bootstrap de ADMIN_HANDLES no pueden revocarse desde Telegram.

- **Acceso:** admin del bot
- **Alias registrados:** —

#### `/unapprove [id]`

Solo admin del bot. Revoca una aprobación usando las mismas reglas de ID que /approve; sin ID en un grupo actúa sobre el chat actual.

- **Acceso:** admin del bot
- **Alias registrados:** `/disapprova`

#### `/unban @usuario | respuesta + /unban`

Solo admin del bot. Quita el ban a un usuario indicado o al autor del mensaje citado.

- **Acceso:** admin del bot
- **Alias registrados:** `/sbanna`
