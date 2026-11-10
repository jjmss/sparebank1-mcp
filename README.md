# sparebank1-mcp

En selvhostet [MCP](https://modelcontextprotocol.io)-server som gir Claude og andre agenter tilgang til
bankdataene dine gjennom SpareBank 1 sine åpne API-er for personkunder
(<https://developer.sparebank1.no>).

Serveren snakker Streamable HTTP, og kan legges inn som *custom connector* i Claude eller brukes fra
Claude Code og andre MCP-klienter.

## Verktøy

| Verktøy | API |
| --- | --- |
| `sb1_list_accounts`, `sb1_get_account`, `sb1_get_account_details`, `sb1_get_account_keys`, `sb1_get_account_balance`, `sb1_list_child_accounts` | Accounts (`/personal/banking/accounts`) |
| `sb1_list_transactions`, `sb1_list_classified_transactions`, `sb1_get_transaction_details`, `sb1_get_classified_transaction_details`, `sb1_export_transactions_csv` | Transactions (`/personal/banking/transactions`) |
| `sb1_get_securities` (seks visninger) | Securities (`/personal/banking/securities`) |
| `sb1_list_financial_institutions` | Financial Institutions |
| `sb1_verify_account_owner` | Account owner |
| `sb1_hello_world` | Hello World (tilkoblingstest) |
| `sb1_transfer_between_accounts`, `sb1_transfer_to_credit_card`, `sb1_transfer_to_pension` | Transfer – **av som standard**, se under |

Bedrifts-API-ene (`/corporate/...`) er ikke med; de er ikke tilgjengelige for en personlig klient.

### Overføringer

Verktøyene som flytter penger registreres bare når `SB1_ENABLE_TRANSFERS=true`. Uten den finnes de
ikke for agenten. API-et tillater kun overføring mellom egne kontoer, til eget kredittkort og til egen
pensjonsavtale, men en agent som kjører rutiner uten tilsyn bør likevel ikke ha dem tilgjengelig.

## Kom i gang

### 1. Registrer en personlig klient hos SpareBank 1

Logg inn på <https://developer.sparebank1.no>, velg **Add new client** og sett redirect-URL til

```
https://<ditt-domene>/sparebank1/callback
```

Ta vare på client id og client secret.

### 2. Konfigurer

Kopier `.env.example` og fyll inn:

| Variabel | Beskrivelse |
| --- | --- |
| `SB1_CLIENT_ID`, `SB1_CLIENT_SECRET` | Fra utviklerportalen. |
| `SB1_FIN_INST` | Valgfri. Banken din, f.eks. `fid-smn`. |
| `PUBLIC_URL` | Adressen serveren nås på, f.eks. `https://sb1-mcp.example.com`. Må være https. |
| `ADMIN_PASSWORD` | Passord for å godkjenne MCP-klienter og starte BankID-innlogging. Minst 16 tegn. |
| `ENCRYPTION_KEY` | 32 byte (base64/hex) som krypterer lagrede tokens: `openssl rand -base64 32`. |
| `MCP_STATIC_TOKEN` | Valgfri. Fast bearer-token for klienter uten OAuth. Minst 32 tegn. |
| `SB1_ENABLE_TRANSFERS` | `true` for å slå på overføringsverktøyene. |

Alle variablene kan også leses fra fil med `<NAVN>_FILE` (Docker secrets).

### 3. Deploy (Dokploy)

1. Opprett en **Compose**-tjeneste i Dokploy som peker på dette repoet (`docker-compose.yml`).
2. Legg inn variablene over under *Environment*.
3. Legg til et domene med HTTPS som peker på tjenesten `mcp`, port `3000`.
4. Deploy. `/healthz` skal svare `{"status":"ok"}`.

Volumet `data` inneholder den krypterte token-fila og må beholdes mellom deploys.

Lokalt:

```bash
npm install
npm run dev
```

### 4. Koble serveren til banken

Åpne `https://<ditt-domene>/`, skriv inn admin-passordet og logg inn med BankID. Serveren lagrer
tokenet kryptert og fornyer det selv.

### 5. Koble til Claude

**Claude (web/desktop/mobil):** *Settings → Connectors → Add custom connector* og lim inn
`https://<ditt-domene>/mcp`. Claude registrerer seg selv, sender deg til serverens godkjenningsside,
og får tilgang når du har skrevet inn admin-passordet.

**Claude Code:**

```bash
claude mcp add --transport http sparebank1 https://<ditt-domene>/mcp
```

Kjør deretter `/mcp` i Claude Code for å logge inn. Klienter uten OAuth kan sende
`Authorization: Bearer <MCP_STATIC_TOKEN>`.

## Sikkerhet

Tokenet fra SpareBank 1 er en langlevd nøkkel til kontoene dine. Slik er det beskyttet:

- **Client secret og bank-token forlater aldri serveren.** MCP-klienter får egne, kortlevde tokens
  utstedt av denne serveren, aldri bankens.
- **Ingen tilgang uten passord.** MCP-endepunktet krever bearer-token. Hvem som helst kan starte en
  OAuth-flyt (slik MCP-klienter er ment å fungere), men ingen token utstedes før admin-passordet er
  skrevet inn. Fem feil passord låser skjemaene i 15 minutter.
- **Kryptert lagring.** Tokens lagres i `data/store.json` med AES-256-GCM. Nøkkelen ligger i miljøet,
  ikke på volumet, så en lekket backup alene er ikke nok. MCP-tokens lagres bare som hasher.
- **Kortlevde MCP-tokens.** Access-token varer én time; refresh-token roteres ved hver bruk.
- **PKCE og eksakt redirect-URI** håndheves, og BankID-callback godtas bare for en `state` serveren
  selv har delt ut.
- **Overføringer er av** med mindre du slår dem på.
- **Ingen hemmeligheter i logger eller feilmeldinger.**
- Containeren kjører som ikke-root med skrivebeskyttet filsystem og uten capabilities.

**Hvis noe er på avveie:** bruk «Koble fra og logg ut alle» på forsiden, og slett klienten i
utviklerportalen til SpareBank 1. Bytt deretter `ADMIN_PASSWORD` og `ENCRYPTION_KEY`.

Husk også at alt agenten leser fra banken havner i samtalen med modellen.

## Tailscale

Custom connectors i Claude (web, mobil og skybaserte rutiner) kalles fra Anthropics servere, ikke
fra din maskin. Serveren må derfor være nåbar fra internett for den bruken; en ren tailnet-adresse
vil ikke fungere.

- **Tailscale Funnel** gir en offentlig `https://<maskin>.<tailnet>.ts.net`-adresse uten eget domene
  eller åpne porter. Den er fortsatt offentlig, så det er OAuth-laget over som beskytter. Sett
  `PUBLIC_URL` til Funnel-adressen.
- **Kun tailnet** (`tailscale serve`) fungerer for klienter som kjører på en maskin i tailnettet,
  f.eks. Claude Code eller Claude Desktop lokalt. Da er serveren ikke eksponert i det hele tatt.
  BankID-innloggingen fungerer fortsatt, siden redirecten skjer i din egen nettleser.

## Utvikling

```bash
npm test
npm run typecheck
npm run build
```

Testene kjører hele flyten (OAuth, BankID-callback, verktøykall, token-fornyelse) mot en
etterlignet bank.

### Ikke verifisert mot ekte API

Serveren er skrevet etter Swagger-spesifikasjonene i utviklerportalen, men er ikke kjørt mot
`api.sparebank1.no` med en ekte klient. Dette er mest sannsynlige steder for avvik:

- Query-parameteren for transaksjonskilde heter «Transaction source» i spesifikasjonen; serveren
  sender `source`. Tilsvarende sendes `accountKey` til `/transactions/classified`.
- Kom-i-gang-guiden viser `/open/personal/banking/...` i ett eksempel, mens resten av portalen bruker
  `/personal/banking/...`. Serveren bruker det siste. Basisadressen kan overstyres med
  `SB1_API_BASE_URL`.
- Guiden beskriver ikke refresh-token. Serveren bruker det hvis banken returnerer et, og ber deg
  ellers logge inn på nytt når tokenet utløper.
