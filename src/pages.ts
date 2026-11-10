import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

const esc = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 30rem; margin: 10vh auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  label { display: block; margin: 1rem 0 .25rem; font-weight: 600; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: .6rem; font: inherit; }
  button { margin-top: 1rem; padding: .6rem 1rem; font: inherit; cursor: pointer; }
  code { word-break: break-all; }
  .note { opacity: .75; font-size: .9rem; }
  .error { color: #c62828; font-weight: 600; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

const passwordField = `<label for="password">Admin-passord</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>`;

export function consentPage(input: {
  requestId: string;
  client: OAuthClientInformationFull;
  redirectUri: string;
  error?: string;
}): string {
  const name = input.client.client_name ?? input.client.client_id;
  return layout(
    'Gi tilgang til SpareBank 1',
    `<h1>Gi tilgang til bankdataene dine?</h1>
<p><strong>${esc(name)}</strong> ber om tilgang til SpareBank 1 MCP-serveren.</p>
<p class="note">Etter godkjenning sendes du til<br><code>${esc(input.redirectUri)}</code><br>
Godkjenn bare hvis du selv nettopp startet denne tilkoblingen og kjenner igjen adressen.</p>
${input.error ? `<p class="error">${esc(input.error)}</p>` : ''}
<form method="post" action="/authorize/approve">
<input type="hidden" name="request" value="${esc(input.requestId)}">
${passwordField}
<button type="submit">Godkjenn tilgang</button>
</form>`,
  );
}

export function homePage(input: { redirectUri: string; mcpUrl: string; error?: string }): string {
  return layout(
    'SpareBank 1 MCP',
    `<h1>SpareBank 1 MCP</h1>
<p>MCP-adresse: <code>${esc(input.mcpUrl)}</code></p>
<p class="note">Redirect-URI som må være registrert på personlig klient hos SpareBank 1:<br>
<code>${esc(input.redirectUri)}</code></p>
${input.error ? `<p class="error">${esc(input.error)}</p>` : ''}
<form method="post" action="/sparebank1/login">
${passwordField}
<button type="submit">Koble til SpareBank 1 med BankID</button>
</form>
<form method="post" action="/admin/revoke">
<p class="note">Mistenker du at noe er på avveie? Dette fjerner bank-tokenet fra serveren og logger ut alle
MCP-klienter. Slett i tillegg klienten i utviklerportalen til SpareBank 1.</p>
<label for="password2">Admin-passord</label>
<input id="password2" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Koble fra og logg ut alle</button>
</form>`,
  );
}

export function messagePage(title: string, message: string): string {
  return layout(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/">Tilbake</a></p>`);
}
