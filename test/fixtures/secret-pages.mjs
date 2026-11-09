// Synthetic credentials only. Never use real service credentials in these fixtures.
export const PAT = 'glpat-PatFixture0123456789AbCd';
export const FEED = 'legacyFeedValue-739125-opaque';
export const GITHUB = 'ghp_GithubFixture0123456789AbCd';
export const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.c2lnbmF0dXJl';
export const AWS = 'AKIAIOSFODNN7EXAMPLE';
export const ENTROPY = 'aQ7mZ2vL9xT4pR8nK1cW6hF3jY5sD0uB';
export const HEX = '8a4d19fc027b63e5d6a03f9c7e215b48';
export const LONG_WORD = 'pneumonoultramicroscopicsilicovolcanoconiosis';
export const URL = `https://example.test/docs/${ENTROPY}?view=overview`;

export const pages = {
  '/gitlab': `<title>GitLab Personal Access Tokens</title>
    <h1>Personal Access Tokens</h1>
    <label for="pat">Access token</label><input id="pat" name="personal_access_token" readonly value="${PAT}">
    <section data-testid="feed-token-widget"><h2>Feed token</h2><span>Feed token</span>
      <input id="feed_token" readonly value="${FEED}"><button>Reveal</button><button>Copy</button>
      <span id="hidden-copy" hidden>${FEED}</span>
      <span id="aria-copy" aria-hidden="true">aria-copy-secret-opaque-739124</span>
      <span id="display-copy" style="display:none">display-copy-token-opaque-739123</span>
    </section><p>Mirror: ${FEED}</p>`,
  '/github': `<title>GitHub tokens</title><h1>Personal access tokens</h1>
    <label>New token <input id="new" readonly value="${GITHUB}"></label><button>Copy token</button>`,
  '/generic': `<title>Generic</title><input id="generic" readonly value="${PAT}"><p>Mirror: ${PAT}</p>`,
  '/formats': `<title>Formats</title><h1>Credentials</h1><code id="jwt">${JWT}</code>
    <p id="aws">Access: ${AWS}</p><p id="split">ghp_<span>SplitInlineFixture0123456789</span></p>
    <pre id="pem">-----BEGIN RSA PRIVATE KEY-----
Zml4dHVyZS1wcml2YXRlLWtleS1ib2R5
-----END RSA PRIVATE KEY-----</pre>
    <button aria-label="Copy ${PAT}">Copy</button><a href="https://example.test/?token=${GITHUB}">Link</a>`,
  '/ordinary': `<title>Ordinary</title><h1>token</h1><h2 id="token-heading"><span>Tokenized headings</span></h2>
    <h2>pinned spinner</h2><label>Pinned <input id="pinned" name="pinned" value="keep-pinned"></label>
    <label>Spinner <input id="spinner" name="spinner" value="keep-spinner"></label>
    <label>Tokenized <input name="Tokenized" value="keep-tokenized"></label>
    <pre>${LONG_WORD}\n${URL}\n${'a'.repeat(64)}</pre>`,
  '/entropy': `<title>Entropy</title><input value="${ENTROPY}"><code id="random">${ENTROPY}</code>
    <pre id="hex">${HEX}</pre><div id="readonly" aria-readonly="true">${ENTROPY}</div>
    <code id="url">https://example.test/?token=${ENTROPY}</code><p>Mirror: ${ENTROPY}</p>`,
};
