# La morte del personal brand · landing webinar

Tre landing per l'A/B/C test del webinar gratuito di Andrea Audisio.

| Cartella | Landing | Variante (arriva al CRM) |
|---|---|---|
| `sala-mortuaria/` | Sala mortuaria, nero e arancione | B |
| `rossa-nera/` | Rossa e nera, struttura Realix | C |
| `necrologio/` | Necrologio color carta, Personal Brand barrato | A |

Ogni cartella è autonoma: `index.html` più le sue immagini in `assets/`, con percorsi relativi. Si può caricare tutto il repository o anche una sola cartella.

## Pubblicare con GitHub Pages

1. Crea un repository su GitHub e carica **tutto il contenuto di questa cartella** (anche il file `.nojekyll`), mantenendo le sottocartelle.
   - Dal sito: **Add file → Upload files** e trascina le cartelle.
   - Oppure da terminale: `git init`, `git add .`, `git commit -m "landing"`, `git push`.
2. Vai in **Settings → Pages**: Source **Deploy from a branch**, branch `main`, cartella `/ (root)`. Salva.
3. Dopo un minuto le landing sono online a questi indirizzi:
   - `https://TUO-UTENTE.github.io/NOME-REPO/sala-mortuaria/`
   - `https://TUO-UTENTE.github.io/NOME-REPO/rossa-nera/`
   - `https://TUO-UTENTE.github.io/NOME-REPO/necrologio/`

Le immagini sono raggiungibili anche singolarmente, per esempio `https://TUO-UTENTE.github.io/NOME-REPO/sala-mortuaria/assets/logo-evento.jpg`. Puoi usare questi URL anche dentro GoHighLevel.

## Collegare i form a GoHighLevel

In fondo a ogni `index.html` c'è il blocco `CONFIG`:

| Campo | Cosa mettere |
|---|---|
| `ghlWebhookUrl` | URL del trigger **Inbound Webhook** di un workflow GHL (uno solo per tutte e tre) |
| `thankYouUrl` | URL della thank-you page (facoltativo: se vuoto, la conferma appare nella pagina) |
| `eventISO`, `dateLong`, `dateShort`, `time` | Data e ora definitive (ora: giovedì 29 ottobre 2026, 21:00, **da confermare**) |
| `vipPrice`, `vipCheckout` | Prezzo e link di pagamento del VIP |
| `whatsapp` | Link del gruppo WhatsApp dell'evento |

Il form invia questi campi:
- `full_name`, `first_name`, `last_name`, `email`, `phone` (formato +39…)
- `variante`, `evento`, `privacy`
- `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `fbclid`, `page_url`

Nel workflow GHL:
1. Usa **Fetch Sample Requests** dopo un'iscrizione di prova.
2. Mappa i campi con **Create/Update Contact**.
3. Aggiungi il tag `variante-{{inboundWebhookRequest.variante}}`.

Meta Pixel: inserisci il codice del Pixel nell'`<head>` di ogni `index.html`. Le pagine inviano già `CompleteRegistration` con il parametro `variant`.

## Da completare nel testo

Nella pagina sono evidenziati in giallo:
- benefit del VIP;
- replay sì o no;
- durata della serata (rossa e nera);
- foto di Andrea, oggi un riquadro segnaposto.
