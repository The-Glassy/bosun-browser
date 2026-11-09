import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskText } from '../src/redact.mjs';
import { JWT, PAT, AWS } from './fixtures/secret-pages.mjs';

const prefixes = ['glpat-', 'glft-', 'glrt-', 'glptt-', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'sk-', 'sk-ant-', 'xoxa-', 'xoxb-', 'xoxp-', 'xoxr-', 'xoxs-'];
for (const prefix of prefixes) {
  test(`secret format ${prefix} is masked everywhere, retaining only its public prefix`, () => {
    const secret = `${prefix}Fixture0123456789AbCdEfGh`;
    const input = `- heading "${secret}" [level=1]\n- button "Copy ${secret}"\nhttps://example.test/?key=${secret}`;
    const result = maskText(input);
    assert.equal(result, input.split(secret).join(`${prefix}…[masked]`));
  });
}
for (const secret of [AWS, 'ASIAIOSFODNN7EXAMPLE', JWT, '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-body\n-----END OPENSSH PRIVATE KEY-----']) {
  test(`mask secret format ${secret.slice(0, 15)}`, () => {
    assert.equal(maskText(`before ${secret} after`), `before ${secret.startsWith('AKIA') ? 'AKIA…' : secret.startsWith('ASIA') ? 'ASIA…' : ''}[masked] after`);
  });
}
for (const label of ['token', 'ToKeN', 'SECRET', 'API-Key', 'api_key', 'private key', 'client_secret', 'feed-token', 'password', 'passcode', 'OTP', 'PIN']) {
  test(`snapshot masks field value for label ${label}, retaining the label`, () => {
    const input = `- heading "${label}" [level=1]\n- textbox "${label}": opaque-value`;
    assert.equal(maskText(input), `- heading "${label}" [level=1]\n- textbox "${label}": [masked]`);
    assert.equal(maskText(`- textbox "${label}":\n  - /placeholder: Keep this label\n  - text: opaque-value`), `- textbox "${label}":\n  - /placeholder: Keep this label\n  - text: [masked]`);
  });
}
test('ordinary words, headings, URLs and short sk- examples are preserved', () => {
  const input = '- heading "token secret pinned spinner Tokenized" [level=1]\n- textbox "pinned": keep-pinned\n- textbox "spinner": keep-spinner\n- textbox "Tokenized": keep-tokenized\nhttps://example.test/docs/longordinarypath\nsk-short';
  assert.equal(maskText(input), input);
});
test('DOM values and their normalized/escaped forms are masked without exposing suffixes', () => {
  const value = 'opaque\n"credential"';
  assert.equal(maskText(JSON.stringify(value), [value]), '"[masked]"');
  assert.equal(maskText('opaque "credential"', [value]), '[masked]');
  assert.equal(maskText(`- textbox: ${PAT}`, [PAT]), '- textbox: glpat-…[masked]');
});
test('quoted YAML field keys and control escapes stay masked', () => {
  assert.equal(maskText(`- 'textbox "API key: production" [ref=e1]': "sensitive\\x01value"`, ['sensitive\x01value']), `- 'textbox "API key: production" [ref=e1]': [masked]`);
});
