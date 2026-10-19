// The natural-language opt-out matcher: clear requests in EN/DE/UK/RU/SK fire; look-alikes don't.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchOptOut, normalize } from '../src/meetings/optout.mjs';

const YES = {
  en: [
    "Please don't record", 'please dont record me', 'Do not record this meeting', 'Stop recording!', 'can you stop the recording please',
    'Please turn off the recorder', "I don't want to be recorded", 'I do not consent to being recorded', "I'd rather not be recorded",
    "I'm not comfortable being recorded", 'no recording please', 'Please delete the recording', 'Don’t record us, thanks', 'STOP RECORDING',
  ],
  de: [
    'Bitte nicht aufnehmen', 'bitte nicht aufzeichnen!', 'Nimm mich bitte nicht auf', 'Nehmen Sie uns nicht auf', 'Aufnahme bitte stoppen',
    'Stopp die Aufnahme', 'Beenden Sie bitte die Aufzeichnung', 'Hör auf aufzunehmen', 'Hören Sie bitte auf mit der Aufnahme',
    'Ich möchte nicht aufgenommen werden', 'Ich will nicht, dass du mich aufnimmst', 'Keine Aufnahme bitte', 'Lösche bitte die Aufnahme',
    'Ich bin mit der Aufnahme nicht einverstanden',
  ],
  uk: ['Не записуй, будь ласка', 'Не записуйте нас', 'Зупиніть запис', 'зупини запис будь ласка', 'Припини запис', 'Вимкніть запис', 'Не хочу, щоб мене записували', 'Без запису, будь ласка', 'Я не даю згоди на запис', 'Видаліть запис'],
  ru: ['Не записывай', 'Пожалуйста, не записывайте', 'Останови запись', 'Прекратите запись!', 'Выключи запись', 'Не хочу, чтобы меня записывали', 'Без записи, пожалуйста', 'Я не согласен на запись', 'Удалите запись', 'Не надо меня записывать'],
  sk: ['Nenahrávaj', 'Prosím, nenahrávajte ma', 'Zastav nahrávanie', 'Zastavte prosím nahrávanie', 'Prestaň nahrávať', 'Vypnite nahrávanie', 'Nechcem byť nahrávaný', 'Bez nahrávania, prosím', 'Nesúhlasím s nahrávaním', 'Vymažte nahrávku'],
};

const NO = {
  en: [
    "Don't stop recording", 'Please keep recording', 'continue recording', 'Is it recording?', 'I recorded a video yesterday',
    "Don't forget to record the demo", 'Can you record the next steps?', 'no recording issues so far', 'The recording quality is bad',
    'stop sharing your screen please', 'record this decision in the notes', "don't stop the recording, it's important", 'Hi everyone!',
    "Hi, I'm Glassy, an AI notetaker. I'm recording audio for notes.",
  ],
  de: ['Nimm das bitte auf', 'Läuft die Aufnahme?', 'Nicht vergessen aufzunehmen', 'Die Aufnahme bitte nicht stoppen', 'Hör nicht auf aufzunehmen', 'Ich habe die Aufnahme gesehen', 'Keine Aufnahme von gestern gefunden', 'Bitte nicht unterbrechen'],
  uk: ['Не зупиняй запис', 'Продовжуй запис', 'Запис іде?', 'Запиши це, будь ласка', 'Не забудь записати', 'запис був хороший'],
  ru: ['Не останавливай запись', 'Продолжай запись', 'Запиши это, пожалуйста', 'Не забудь записать', 'Запись идёт?', 'Без записи не обойтись'],
  sk: ['Nezastavuj nahrávanie', 'Pokračuj v nahrávaní', 'Nahraj to prosím', 'Nezabudni nahrávať', 'Nahrávaš?', 'Nahrávka je super'],
};

for (const lang of Object.keys(YES)) {
  test(`opt-out matcher, ${lang}: clear requests fire`, () => {
    for (const t of YES[lang]) assert.ok(matchOptOut(t), `should match: ${t}`);
  });
  test(`opt-out matcher, ${lang}: look-alikes don't`, () => {
    for (const t of NO[lang]) assert.equal(matchOptOut(t), null, `should not match: ${t}`);
  });
}

test('clauses: a veto only cancels its own clause; long messages are still read', () => {
  assert.ok(matchOptOut("Bob said keep recording, but I do not consent to being recorded."));
  assert.ok(matchOptOut('Ich weiß, du sollst nicht aufhören. Aber bitte nicht aufnehmen!'));
  assert.ok(matchOptOut(`Please don't record. ${'Some context about why. '.repeat(80)}`));
  assert.equal(matchOptOut("Please keep recording, but don't stop the recording."), null);
  assert.equal(matchOptOut("Don't stop recording. We need it."), null);
});

test('normalize: case, apostrophes, punctuation, whitespace', () => {
  assert.equal(normalize('  Don’t   RECORD!!! '), "don't record");
  assert.equal(normalize('Bitte, nicht aufnehmen.'), 'bitte nicht aufnehmen');
  assert.equal(matchOptOut('x'.repeat(5000)), null);
  assert.equal(matchOptOut(''), null);
});
