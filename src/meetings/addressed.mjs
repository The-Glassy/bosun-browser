// Whether a transcript final addresses the agent by name: the meeting's `addressed` mark (Bosun only marks; what to do
// with it is the agent's call). Names come from the join `name` (and the account name the call shows) and the speech
// setting name_aliases.
//
// Speech-to-text writes a name the way it heard it: "Glassy", "Glassi", "Гласі", "Глассі", "Гласси". So words are
// compared by a loose key, not by spelling: lower case, diacritics dropped, Cyrillic transliterated (Ukrainian and
// Russian letters alike), y -> i, h -> g (Ukrainian "г" is an h), w -> v, x -> ks, ph -> f, ck -> k, and doubled letters
// made single. "Glassy", "Гласі", "Глассі" and "Гласси" all become "glasi". A possessive ('s) is dropped. An alias of
// several words matches those words in a row. Keys shorter than 3 letters never match ("AI", "Bo"): too many false hits.

const CYR = {
  а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', є: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'sch', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'iu', я: 'ia',
};
const MIN_KEY = 3;

// The loose key of one word.
export function nameKey(word) {
  let w = String(word || '').toLowerCase().replace(/[‘’ʼ`]/g, "'").replace(/'s$/, '').replace(/'/g, '');
  // Cyrillic first (й would otherwise lose its breve and stay Cyrillic), then diacritics off what is left.
  w = [...w].map((c) => CYR[c] ?? c).join('').normalize('NFD').replace(/\p{M}/gu, '');
  w = w.replace(/[^a-z0-9]/g, '');
  w = w.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/x/g, 'ks').replace(/w/g, 'v').replace(/y/g, 'i').replace(/h/g, 'g');
  return w.replace(/(.)\1+/g, '$1');
}

const wordsOf = (text) => String(text || '').match(/[\p{L}\p{N}'’ʼ]+/gu) || [];

// The names to listen for, as lists of word keys: each name whole, and the first word of a name of several words
// ("Glassy Notetaker" -> also "Glassy"); a bracketed note is no part of a name ("Glassy (notetaker)" -> "Glassy").
// Aliases are taken as given (whole, and not split).
export function aliasKeys({ names = [], aliases = [] } = {}) {
  const out = new Map();
  const add = (s) => {
    const keys = wordsOf(s).map(nameKey).filter(Boolean);
    if (!keys.length || keys.join('').length < MIN_KEY) return;
    out.set(keys.join(' '), keys);
  };
  for (const n of names) {
    const plain = String(n || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    add(plain);
    const first = wordsOf(plain)[0];
    if (first && wordsOf(plain).length > 1) add(first);
  }
  for (const a of aliases) add(a);
  return [...out.values()];
}

// Whether text contains one of the names (aliasKeys) as whole words.
export function isAddressed(text, keys) {
  if (!keys?.length) return false;
  const w = wordsOf(text).map(nameKey);
  return keys.some((k) => {
    for (let i = 0; i + k.length <= w.length; i++) {
      if (k.every((x, j) => w[i + j] === x)) return true;
    }
    return false;
  });
}
