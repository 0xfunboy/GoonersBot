# GoonersBot — architettura caratteriale e interazioni umane

Questo documento descrive **come GoonersBot costruisce una relazione coerente con le persone** senza ridurre il carattere a un singolo prompt. Il comportamento nasce dalla combinazione di storico recente, memoria di lavoro, profili sociali persistenti, RAG, embedding, stato emotivo verso il singolo utente, evaluator delle action, stile, anti-ripetizione e feedback.

## 1. Flusso di un'interazione

```text
messaggio Telegram
  ↓
storico recente + reply/quote + thread semantico
  ↓
profilo sociale della stanza e delle persone coinvolte
  ↓
SceneAnalyzer → situazione umana del turno
  ↓
Cortex LLM → intento, action/tool, valore da portare, ruolo sociale, roast budget
  ↓
RAG personale/gruppo + knowledge RAG + ambient recall + eventuale web/news
  ↓
Standing (rapporto storico) + Heat (ostilità del momento)
  ↓
StyleEngine + ReplyPlanner
  ↓
generazione di più candidate → ranking → social floor → anti-ripetizione
  ↓
risposta + registrazione di memoria usata, joke usato e feedback successivo
```

Il principio è: **prima si decide cosa sta succedendo e cosa bisogna fare, poi si decide come dirlo**. Il carattere non può trasformare una richiesta tecnica in una battuta inutile, né un'amicizia può decidere chi ha ragione su un fatto.

## 2. I diversi tipi di memoria

| Livello                                            |              Persistenza | Funzione                                                                                                                |
| -------------------------------------------------- | -----------------------: | ----------------------------------------------------------------------------------------------------------------------- |
| **History** (`messages`)                           |           breve/retained | ultime battute della chat, chi ha detto cosa, reply recenti                                                             |
| **Thread state** (`conversation_threads/entities`) |              giorni, TTL | mantiene il filo semantico: “quella”, “scaricalo”, “la mia macchina”, proprietà di oggetti/topic; usa anche embedding   |
| **Social profile**                                 |                    lunga | modello strutturato della persona: interessi, preferenze, avversioni, skill, ruolo, stile comunicativo, goal, abitudini |
| **Social graph**                                   |                    lunga | rapporti direzionali fra persone: affinity, warmth, trust, banter affinity, support, rivalry, familiarity               |
| **Running jokes / norme**                          | lunga ma con decadimento | cultura condivisa della chat, inside joke con fatigue/cooldown, regole sociali osservate                                |
| **Standing** (`social_standing`)                   |                     mesi | come quella persona ha trattato **il bot**: rapporto, conflitti reali, eventuale stato `friend`                         |
| **Heat** (`user_heat`)                             |                   minuti | quanto il bot è irritato **adesso** con quel singolo utente; decade rapidamente                                         |
| **Memory items / Group RAG**                       |                    lunga | lore episodica: meme, quote, group lore e memoria legacy revisionabile                                                  |
| **Knowledge RAG / Ambient recall**                 |               conoscenza | fatti esterni/curati pertinenti al topic, distinti dalle informazioni personali                                         |
| **Bot replies + feedback**                         |                  recente | cosa il bot ha già detto, stile usato, joke premise, memorie usate, reazioni positive/negative                          |

### Thread e attribuzione

`ConversationThreadTracker` è una memoria di lavoro diversa dalla lore. Collega follow-up allo stesso argomento usando **reply Telegram, alias, entità note, ownership e similarità embedding**. Registra chi possiede o ha introdotto il topic e impone una regola fondamentale: il bot deve rispondere al parlante corrente senza attribuirgli fatti appartenenti a un'altra persona. I transcript/media provenienti dal messaggio citato restano contesto **read-only**: non diventano parole o biografia del parlante corrente. Anche il roast segue l'attribuzione reale.

## 3. Persone, amici, ostili e “nemici”

Il `SocialProfileEngine` mantiene un profilo evolutivo per ogni membro. L'identità stabile è il **Telegram user ID**; lo username è una label mutabile, quindi se un utente cambia handle la storia sociale può essere riconciliata senza creare una persona nuova. Ogni claim conserva `confidence`, salience, fonte, message ID di provenienza e stato (`active`, `disputed`, `superseded`, `retracted`, `stale`), così una correzione può sostituire una vecchia informazione invece di accumulare contraddizioni.

### Amicizia verso il bot

`SocialStandingService` misura il rapporto personale **utente → bot** su scala `-100..+100`. Ringraziamenti e calore aumentano il rapport, difendere il bot pesa ancora di più; il normale sfottò vale **zero**, perché nel gruppo insultarsi per gioco non deve essere interpretato come ostilità reale. Solo un conflitto classificato come genuino riduce il rapporto.

Lo stato persistente `friend` viene guadagnato lentamente: **rapport ≥ 40, almeno 20 interazioni e nessun conflitto recente (30 giorni se ce n'è stato uno)**. Un amico ha roast ceiling `light`; un utente `warm` arriva a `medium`. Un conflitto reale può revocare il tag friend. Il rapport negativo invece **decade col tempo verso zero**: il bot conserva le amicizie conquistate ma non porta rancore per sempre.

Non esiste un flag permanente `enemy`. Esistono bande `prickly` e `hostile`, un eventuale rapporto sociale `rivalry` e il `Heat` del momento. È intenzionale: **l'ostilità è uno stato correggibile, non un'identità assegnata alla persona**.

### Heat: la discussione di adesso

`HeatService` è separato dallo standing. Sale con attacchi diretti, critica e `insult_bot`, scende naturalmente e cala molto se l'utente si scusa o de-escalation. Dai livelli `irritato → ostile → incazzato → furia` deriva un minimo di aggressività per **quell'utente e quel turno**. Sotto 20 non viene neppure iniettato nel prompt: il baseline è amicizia normale. Se il turno è vulnerabile/serio, il social floor può spegnere comunque roast e aggressività.

Standing e Heat modificano il **tono**, non le conclusioni. `resolveStance` e le fonti fattuali decidono invece la sostanza: un amico può essere corretto e un utente ostile può avere ragione.

## 4. Memorie personali, RAG ed embedding

La memoria durevole non è un dump dello storico. `MemoryMiner` estrae candidate strutturate con un LLM dedicato e applica firewall deterministici: niente segreti, credenziali, infrastruttura/PII, profiling sensibile, diagnosi, attacchi identitari, dettagli intimi o accuse criminali. Una memoria automatica deve inoltre citare **veri message ID umani** e handle già osservati: il modello non può inventare una persona o una provenienza.

Oggi c'è una separazione netta: **preferenze, interessi, skill, ruoli, relazioni, norme e running joke appartengono al social graph**; `memory_items` rimane soprattutto per memoria episodica (`meme`, `quote`, `group_lore`) e per aggiornare/ritirare vecchia lore migrata. `LoreEngine` gestisce dedupe, reinforce, update, expire, revision history e cancellazione per utente/message ID.

Quando serve memoria, il bot recupera solo pochi elementi pertinenti. Il punteggio combina: speaker corrente o persona menzionata/reply, salience, freschezza, similarità semantica o keyword/topic, numero di utilizzi e cooldown. Una memoria personale è però **subject-bound**: embedding o keyword non possono trascinare la lore di un utente estraneo dentro il turno di un altro. Il recall cross-user è consentito solo quando Cortex/scene hanno classificato una vera richiesta di memoria/recap. **Recuperare una memoria non significa usarla**: `ReplyPlanner` può scegliere `none`, `implicit_style` o, raramente e solo se consentito, `explicit_callback`.

Con embedding attivi, `VectorMemoryRetriever` crea un vettore da messaggio corrente + topic + ultimi turni (prima redatti da segreti) e usa cosine similarity. Se l'endpoint embedding non funziona o la dimensione è errata, il sistema degrada automaticamente a matching lessicale/Jaccard. Gli embedding vengono usati anche per collegare thread semantici. `scripts/backfillEmbeddings.ts` completa in batch gli embedding mancanti di memory items e knowledge base. L'isolamento per `chatId` è sempre deterministico: nessuna memoria viene cercata fuori dalla chat.

## 5. Scene, Cortex, evaluator e action

`SceneAnalyzer` legge il turno nel suo contesto e produce: topic, energia, utenti attivi, intento umano, critica al bot, rischio, opportunità di memoria e soprattutto `socialSignal`. Sotto l'LLM esiste un classificatore deterministico di sicurezza sociale che distingue **distress urgente, vulnerabilità/lutto, gratitudine, aiuto pratico, celebrazione, conflitto, domanda fattuale, banter, gioco creativo e casual**. Se il modello sottovaluta una situazione seria, vince il segnale più prudente: in vulnerabilità il roast viene azzerato e i callback personali vengono evitati.

Con `CORTEX_LLM_ENABLED`, **Cortex è l'evaluator principale delle action**. Non cerca keyword per decidere il comando: riceve messaggio, reply citato, history, thread/social context e tool realmente disponibili, poi restituisce JSON strutturato con:

- `intents[]` (answer, support, banter, web lookup, media, anime, ecc.);
- `toolCalls[]` (`web_search`, `group_rag`, `knowledge_rag`, `anime_archive`, `music`, `link_media`, `image_gen`, `video_gen`, `translate`, `tts`, ecc.);
- `valueTarget`: truth, context, technical_help, support, joke o social_glue;
- `socialRole`: friend, truth_checker, technical_peer, lorekeeper, banter o quiet_listener;
- `roastBudget`, grounding, confidence e reason.

Da qui nasce la `TurnEvaluation`: rispondere, stare zitto, correggere un claim, cercare sul web, usare lore, generare media, rehostare, tradurre, fare TTS, ecc. Se Cortex è disabilitato esiste ancora `TurnEvaluator` LLM+euristico; se Cortex fallisce viene usato `fallbackCortex`. Nell'autoengage passivo viene usato il fallback deterministico perché un evaluator precedente ha già deciso che vale la pena intervenire.

## 6. Come nasce il carattere finale e come impara

`StyleEngine` non ha una sola persona fissa: sceglie combinazioni fra varianti come `dry`, `venomous`, `surreal`, `meme_lord`, `lorekeeper`, `older_brother`, `curious_nerd`, `deadpan_caring`, ecc. e un **meccanismo comico separato** (osservazione chirurgica, analogia assurda, understatement, self-own, callback remix, shared enemy...). Il contesto serio restringe il pool a stili affidabili; tecnico/fattuale favorisce peer/nerd; il feedback recente penalizza gli stili che hanno funzionato male e può favorire quelli apprezzati, senza ripeterli subito.

`ReplyPlanner` converte scene + evaluation + standing + memorie in vincoli prima della generazione: cosa deve fare la risposta, quanta memoria può usare, chi è il target, lunghezza, roast massimo, frasi vietate e novelty instruction. Due ceiling indipendenti limitano il roast: **quanto consente questo momento** e **quanto consente la relazione storica con questa persona**.

Il generatore produce più candidate. `ResponseRanker` le ordina; `RepetitionGuard` blocca cloni lessicali/semantici, catchphrase, aperture ripetute, callback di memoria saturi e risposte che eludono il compito. In supporto serio esiste un `social floor` che scarta risposte ostili anche se il modello le ha generate. Sui turni con più persone o biografia entra inoltre un `AttributionVerifier`: tratta i vecchi messaggi del bot come **non-evidenza**, verifica che ogni fatto appartenga al soggetto giusto e impedisce di trasformare `communication_style`, running joke o reputation in nazionalità, lavoro o altra biografia. Una rewrite viene verificata una seconda volta; se resta ambigua il bot elimina la lore personale invece di rischiare un incrocio.

Infine il bot registra **quale memoria e quale running joke ha davvero usato**. Le reply successive e le reaction Telegram alimentano il feedback: uno stile/joke apprezzato diventa più probabile in futuro quando compatibile, uno bocciato viene raffreddato; la salience delle memorie effettivamente usate sale o scende. I running joke accumulano `fatigue` e hanno cooldown, quindi una gag di gruppo può vivere a lungo senza diventare la risposta automatica a ogni messaggio.

### In sintesi

GoonersBot non “ha un carattere” salvato in una stringa: **mantiene una rappresentazione distinta di persona, relazione, momento, argomento e memoria**, poi lascia a Cortex decidere cosa fare e a Planner/StyleEngine decidere come farlo. La memoria sociale dà continuità, Standing crea amici reali, Heat rende credibili i conflitti temporanei, RAG/embedding recuperano solo ciò che serve, e feedback + anti-ripetizione impediscono che la familiarità degeneri in un NPC che ripete sempre le stesse battute.
