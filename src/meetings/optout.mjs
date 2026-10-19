// "Please don't record": a conservative natural-language matcher for meeting chat, in English, German, Ukrainian,
// Russian and Slovak. It fires on clear requests to stop or not to record (or to delete the recording), and not on
// look-alikes such as "don't stop recording", "keep recording", "record the next steps" or "is it recording?".
// Anything it misses still reaches the agent, which gets every chat message as an event and can stop the recording
// itself (meeting_stop_recording).

// Lower case, typographic apostrophes straightened, punctuation dropped, whitespace collapsed.
export function normalize(text) {
  return String(text).normalize('NFKC').toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const B = '(?<![\\p{L}\\p{N}])', E = '(?![\\p{L}\\p{N}])'; // word boundaries that know about Cyrillic and umlauts
const rx = (src) => new RegExp(`${B}(?:${src})${E}`, 'u');
const whole = (src) => new RegExp(`^(?:${src})$`, 'u');
const PLEASE = "(?:please|pls|bitte|будь ласка|пожалуйста|prosím|prosim)";

// [language, regex]: any match is an opt-out, unless a VETO matches the same message.
const RULES = [
  // English
  ['en', rx("(?:please |pls )?(?:don'?t|do not|dont|never) (?:record|tape)(?: (?:me|us|this|that|it|the (?:call|meeting)))?")],
  ['en', rx('(?:stop|end|pause|halt|kill|cancel|turn off|switch off|disable|delete|remove|discard) (?:the |your |this )?(?:recording|recorder|audio recording)')],
  ['en', rx('stop recording')],
  ['en', rx("(?:i|we) (?:don'?t|do not|dont) (?:want|wish|consent|agree)(?: to)?(?: to)? (?:be |being )?(?:recorded|recording|to recording|to being recorded)")],
  ['en', rx("(?:i|we) (?:don'?t|do not|dont) consent to (?:being )?record(?:ed|ing)")],
  ['en', rx("(?:i'?d|i would|we'?d|we would) (?:rather|prefer) not (?:to )?be recorded")],
  ['en', rx("(?:i'?m|i am|we'?re|we are) not (?:ok|okay|comfortable|fine) (?:with )?(?:being )?record(?:ed|ing)")],
  ['en', whole(`(?:${PLEASE} )?no (?:recording|recordings)(?: ${PLEASE})?`)],
  // German
  ['de', rx('(?:bitte )?nicht (?:aufnehmen|aufzeichnen|mitschneiden)')],
  ['de', rx('(?:nimm|nehmt|nehmen sie) (?:mich |uns |das |es )?(?:bitte )?nicht (?:mehr )?auf')],
  ['de', rx('(?:zeichne|zeichnet|zeichnen sie) (?:mich |uns |das |es )?(?:bitte )?nicht (?:mehr )?auf')],
  ['de', rx('(?:die )?(?:aufnahme|aufzeichnung) (?:bitte )?(?:stoppen|beenden|abbrechen|ausschalten|löschen|loeschen)')],
  ['de', rx('(?:stopp|stoppe|stop|stoppt|stoppen sie|beende|beendet|beenden sie|lösch|lösche|löscht|löschen sie|schalte|schalten sie) (?:bitte )?(?:die |deine |eure |ihre )?(?:aufnahme|aufzeichnung)')],
  ['de', rx('(?:hör|höre|hört|hören sie) (?:bitte )?(?:sofort )?auf (?:mit der (?:aufnahme|aufzeichnung)|aufzunehmen|aufzuzeichnen)')],
  ['de', rx('(?:ich|wir) (?:möchte|möchten|will|wollen|mag) nicht (?:aufgenommen|aufgezeichnet) werden')],
  ['de', rx('(?:ich|wir) (?:möchte|möchten|will|wollen) nicht dass (?:du |sie |ihr )?(?:mich |uns |das |es )?(?:aufnimmst|aufnehmen|aufnehmt|aufzeichnest|aufzeichnen)')],
  ['de', rx('(?:bin|sind) (?:mit (?:der |einer )?(?:aufnahme|aufzeichnung) )?nicht einverstanden(?: mit (?:der |einer )?(?:aufnahme|aufzeichnung))?')],
  ['de', whole(`(?:${PLEASE} )?keine (?:aufnahme|aufnahmen|aufzeichnung)(?: ${PLEASE})?`)],
  // Ukrainian
  ['uk', rx('не записуй(?:те)?')],
  ['uk', rx('не треба (?:мене |нас |це )?записувати')],
  ['uk', rx('(?:зупини|зупиніть|припини|припиніть|вимкни|вимкніть|видали|видаліть) (?:будь ласка )?запис')],
  ['uk', rx("не хочу щоб (?:мене|нас) записували")],
  ['uk', rx('(?:я|ми) не (?:даю|даємо|згоден|згодна|згодні)(?: згоди)? на запис')],
  ['uk', whole(`(?:${PLEASE} )?без запису(?: ${PLEASE})?`)],
  // Russian
  ['ru', rx('не записывай(?:те)?')],
  ['ru', rx('не надо (?:меня |нас |это )?записывать')],
  ['ru', rx('(?:останови|остановите|прекрати|прекратите|выключи|выключите|удали|удалите) (?:пожалуйста )?запись')],
  ['ru', rx('не хочу чтобы (?:меня|нас) записывали')],
  ['ru', rx('(?:я|мы) не (?:даю|даём|даем|согласен|согласна|согласны)(?: согласия)? на запись')],
  ['ru', whole(`(?:${PLEASE} )?без записи(?: ${PLEASE})?`)],
  // Slovak
  ['sk', rx('nenahrávaj(?:te)?|nenahravaj(?:te)?')],
  ['sk', rx('(?:zastav|zastavte|prestaň|prestaňte|vypni|vypnite|vymaž|vymažte) (?:prosím )?(?:nahrávanie|nahrávať|nahrávku|nahravanie|nahravat)')],
  ['sk', rx('nechcem (?:aby (?:si|ste) (?:ma|nás) nahrával(?:a|i)?|byť nahrávan(?:ý|á|í))')],
  ['sk', rx('nesúhlasím s nahrávaním')],
  ['sk', whole(`(?:${PLEASE} )?bez nahrávania(?: ${PLEASE})?`)],
];

// A request NOT to stop, or to go on: never an opt-out, whatever else matched.
const VETO = [
  rx("(?:don'?t|do not|dont|never) (?:stop|end|pause|turn off|switch off|delete)"),
  rx('(?:keep|continue|go on|carry on) (?:on )?recording'),
  rx('nicht (?:stoppen|beenden|abbrechen|löschen|aufhören)'),
  rx('(?:hör|höre|hört) nicht auf'),
  rx('не (?:зупиняй|зупиняйте|припиняй|припиняйте|вимикай|вимикайте|видаляй|видаляйте)'),
  rx('не (?:останавливай|останавливайте|прекращай|прекращайте|выключай|выключайте|удаляй|удаляйте)'),
  rx('(?:nezastavuj|nezastavujte|neprestávaj|neprestávajte|nevypínaj|nevypínajte|nemaž)'),
];

// A message is judged per clause: sentences, and the parts around "but"-like contrasts, so "Bob said keep recording,
// but I do not consent to being recorded" is an opt-out while "don't stop recording" is not.
const CONTRAST = /\s(?:but|however|though|aber|jedoch|sondern|doch|але|проте|но|однако|ale|avšak)\s/u;
export function clauses(text) {
  return String(text).slice(0, 4000).split(/[.!?;\n\u3002]+/u)
    .flatMap((sentence) => normalize(sentence).split(CONTRAST))
    .map((c) => c.trim()).filter(Boolean);
}

// -> {lang, rule} for an opt-out request, else null.
export function matchOptOut(text) {
  for (const c of clauses(text)) {
    if (VETO.some((v) => v.test(c))) continue;
    for (let i = 0; i < RULES.length; i++) if (RULES[i][1].test(c)) return { lang: RULES[i][0], rule: i };
  }
  return null;
}
