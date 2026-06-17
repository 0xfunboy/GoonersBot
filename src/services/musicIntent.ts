/**
 * Natural-language detection for music requests in Italian, English and Spanish.
 *
 * Examples that should match (the captured query is in []):
 *   "mi canti [piccola kitty dolce kitty]"      "mi fai sentire [bohemian rhapsody]"
 *   "suona [despacito]"      "suonami [creep dei radiohead]"      "metti su [blur song 2]"
 *   "play [smells like teen spirit]"     "sing me [hallelujah]"     "let me hear [clair de lune]"
 *   "cántame [bésame mucho]"     "ponme [la bamba]"     "reproduce [gasolina]"
 *
 * Detection is anchored at the start of the (mention-stripped) message so it does not fire on the
 * verb appearing mid-sentence. Callers should only run this when the bot is addressed.
 */

// Lead words/politeness that may precede the verb (stripped iteratively before verb detection).
const LEAD_RE =
  /^(?:ehi|ehy|hey|oi|ciao|hola|dai|su|senti|oye|ti\s+prego|per\s+favore|por\s+favor|porfa|please|plz|bot|gooners?|puoi|potresti|me\s+puoi|mi\s+puoi|puedes|podr[íi]as|can\s+you|could\s+you|mi|me|ci|nos|ma)\b[\s,]*/i;

// The trigger verbs (multiword variants first so the alternation prefers the longer match).
const VERB_SOURCE = [
  'fammi\\s+sentire',
  'fai\\s+sentire',
  'fammi\\s+ascoltare',
  'fai\\s+ascoltare',
  'fai\\s+partire',
  'metti\\s+su',
  'let\\s+me\\s+hear',
  'lemme\\s+hear',
  'hazme\\s+escuchar',
  'put\\s+on',
  'cantami',
  'cantarmi',
  'cantame',
  'c[áa]ntame',
  'cantare',
  'canti',
  'canta',
  'suonami',
  'suonarmi',
  'suonare',
  'suoni',
  'suona',
  'riproduci',
  'reprod[úu]ceme',
  'reproduceme',
  'reproduce',
  't[óo]came',
  'tocame',
  'toca',
  'ponme',
  'p[óo]nme',
  'p[óo]n',
  'pon',
  'mettimi',
  'mandami',
  'metti',
  'sing',
  'play',
].join('|');

const VERB_RE = new RegExp(`^(?:${VERB_SOURCE})\\s+(.+)$`, 'i');

// Leading object pronoun inside the captured query ("play me X" -> "X", "sing us X" -> "X").
// NOTE: do NOT strip articles (la/il/the/el...) - they are frequently part of the title
// ("La Bamba", "The Wall", "Il Pagliaccio").
const QUERY_LEAD_RE = /^(?:me|mi|us|nos|ci)\s+/i;

// Trailing politeness to drop from the query.
const QUERY_TAIL_RE =
  /[\s,]*(?:per\s+favore|por\s+favor|porfa|please|plz|grazie|gracias|thanks|thx|dai|ti\s+prego|gracie)\s*[!.?]*$/i;

function stripMention(text: string, botUsername?: string): string {
  let s = text;
  if (botUsername) {
    const handle = botUsername.replace(/^@/, '');
    s = s.replace(new RegExp(`@${handle}\\b`, 'gi'), ' ');
  }
  return s.replace(/\s+/g, ' ').trim();
}

function cleanQuery(raw: string): string {
  let q = raw.trim();
  // strip surrounding quotes/backticks
  q = q.replace(/^["'«»“”`]+|["'«»“”`]+$/g, '').trim();
  // drop a leading article/pronoun a couple of times
  for (let i = 0; i < 2; i++) {
    const next = q.replace(QUERY_LEAD_RE, '').trim();
    if (next === q) break;
    q = next;
  }
  // drop trailing politeness
  q = q.replace(QUERY_TAIL_RE, '').trim();
  // strip any residual surrounding quotes after trimming
  q = q.replace(/^["'«»“”`]+|["'«»“”`]+$/g, '').trim();
  return q;
}

/**
 * Returns the song query if `text` is a natural-language music request, otherwise null.
 * Pass `botUsername` to strip an addressing mention first.
 */
export function parseMusicRequest(text: string, botUsername?: string): string | null {
  if (!text) return null;
  let s = stripMention(text, botUsername);
  if (!s) return null;

  // strip leading filler/politeness words
  for (let i = 0; i < 4; i++) {
    const next = s.replace(LEAD_RE, '');
    if (next === s) break;
    s = next;
  }

  const m = VERB_RE.exec(s);
  if (!m || !m[1]) return null;
  const query = cleanQuery(m[1]);
  if (query.length < 2) return null;
  return query;
}
