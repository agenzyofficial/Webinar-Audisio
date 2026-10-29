# La morte del personal brand · landing webinar

Landing del webinar gratuito di Andrea Audisio: la variante **Sala mortuaria** (nero e arancione, arriva al CRM come variante B). Le varianti A (Necrologio) e C (Rossa e nera) sono state tolte e restano nella cronologia git.

| Pagina | File | Indirizzo |
|---|---|---|
| Landing | `index.html` | https://webinar-audisio.vercel.app/ |
| Pagina VIP con checkout Whop | `vip/index.html` | https://www.personalbrandmorto.com/vip/ (dai bottoni VIP; dopo l'iscrizione gratuita arriva qui in versione upsell con `?da=iscrizione`) |
| Dopo l'iscrizione gratuita | cartella `accesso-…` | pagina corta: avviso, biglietto VIP (porta a `/vip/`) e gruppo WhatsApp; ci porta il modulo (`thankYouUrl` in `index.html`) |
| Grazie (iscrizione gratuita) | cartella `conferma-…` | calendario e passi; ci si arriva da "Segnati la serata in calendario" |
| Grazie VIP (dopo il pagamento di 27 €) | cartella `vip-…` | si imposta solo nel checkout come pagina di ritorno |

Le pagine di grazie hanno nomi non indovinabili e i vecchi `/grazie/` e `/grazie-vip/` non esistono più, così non le trova chi non si è iscritto o non ha pagato. Il nome della pagina VIP non va scritto nella landing, che chiunque può leggere.

Le immagini sono in `assets/`, con percorsi relativi, e si possono usare anche dentro GoHighLevel (per esempio `https://webinar-audisio.vercel.app/assets/logo-evento.jpg`).

## Pubblicazione su Vercel

Progetto Vercel `webinar-audisio`. `vercel.json` rimanda i vecchi indirizzi `/sala-mortuaria/…` alle pagine nuove e `/rossa-nera/` e `/necrologio/` alla home.

A ogni push su `main` il workflow `.github/workflows/deploy-vercel.yml` pubblica in produzione. Serve il secret `VERCEL_TOKEN` in **Settings → Secrets and variables → Actions**: senza, il deploy viene saltato. Si può lanciare anche a mano da **Actions → Deploy su Vercel → Run workflow**.

## Collegare i form a GoHighLevel

In fondo a `index.html` c'è il blocco `CONFIG`:

| Campo | Cosa mettere |
|---|---|
| `ghlWebhookUrl` | URL del trigger **Inbound Webhook** di un workflow GHL |
| `thankYouUrl` | URL della thank-you page (facoltativo: se vuoto, la conferma appare nella pagina) |
| `eventISO`, `dateLong`, `dateShort`, `time` | Data e ora definitive (ora: giovedì 29 ottobre 2026, 21:00, **da confermare**) |
| `vipPrice`, `vipCheckout` | Prezzo e link di pagamento del VIP |
| `whatsapp` | Link del gruppo WhatsApp dell'evento |

Il form invia questi campi:
- `full_name`, `first_name`, `last_name`, `email`, `phone` (formato +39…)
- `variante`, `evento`, `privacy`, `ticket` (`gratuito` per l'iscrizione, `vip` per chi compra i 27 €)
- `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `fbclid`, `page_url`

Nel workflow GHL:
1. Usa **Fetch Sample Requests** dopo un'iscrizione di prova.
2. Mappa i campi con **Create/Update Contact**.
3. Aggiungi il tag `variante-{{inboundWebhookRequest.variante}}`.
4. Ramo If/Else su `inboundWebhookRequest.ticket` uguale a `vip` → tag `vip`. Arriva con `tipo=acquisto_vip` dal webhook di Whop (`api/whop.js`, evento `payment.succeeded`) a ogni acquisto del Biglietto VIP, con il telefono preso dalla domanda obbligatoria "Numero WhatsApp" del checkout (letta dall'iscrizione con `WHOP_API_KEY`), e con `tipo=scheda_vip` quando un VIP manda la scheda.
5. La scheda VIP (`tipo=scheda_vip`) arriva anche tutta in un solo campo, `scheda_testo`, con domande e risposte su più righe: mappalo su un campo personalizzato di tipo testo lungo.

Whop su Vercel: `WHOP_API_KEY` (chiave API dell'account Whop) serve ad `api/whop.js` per leggere il numero WhatsApp e ad `api/whop-cliente.js`, che dopo il pagamento compila e blocca nome, cognome, email e WhatsApp nella scheda VIP. `WHOP_WEBHOOK_SECRET` (facoltativa) attiva il controllo della firma del webhook.

Meta Pixel: inserisci il codice del Pixel nell'`<head>` di `index.html`. La pagina invia già `CompleteRegistration` con il parametro `variant`.

## Da completare nel testo

Nella pagina sono evidenziati in giallo:
- benefit del VIP;
- replay sì o no;
- foto di Andrea, oggi un riquadro segnaposto.

Stato della diretta: `api/live.js` (POST con la chiave del pannello) manda lo stato del bottone della call al servizio in tempo reale `live-worker/` (Cloudflare Worker `pbm-live` con un Durable Object: la pagina della diretta resta collegata via WebSocket e il bottone compare o sparisce in circa un secondo) e lo scrive anche in `live/stato.json` nello spazio Vercel Blob `pbm-live` (pubblico, aggiornato dalla rete entro 60 secondi), che la pagina rilegge solo se la connessione cade. Vale sempre lo stato con l'ora più recente. Nel codice c'è solo l'impronta SHA-256 della chiave, non la chiave. Il Worker si pubblica con `npx wrangler deploy` dalla cartella `live-worker/` (account Cloudflare dello Stream).

Chat della diretta: viaggia sullo stesso WebSocket del bottone e i messaggi stanno nel Durable Object (SQLite). Si modera dal pannello con la stessa chiave: cancella un messaggio, banna chi l'ha scritto (IP, per IPv6 la rete /64, più un codice del dispositivo salvato nel browser; spariscono anche tutti i suoi messaggi), sblocca, chiudi o riapri la scrittura per tutti, svuota. Niente link in chat, un messaggio ogni 3 secondi a testa, 300 caratteri. Dopo aver cambiato `sorgente.json`, la richiesta `POST /chat` con `azione: "sorgente"` fa rileggere la sorgente a tutte le pagine aperte; collegate al tempo reale la rileggono comunque ogni 3 minuti (ogni 20 secondi senza).
