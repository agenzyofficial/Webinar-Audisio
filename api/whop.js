/* Whop → GHL.
   Whop chiama questo indirizzo a ogni pagamento riuscito (webhook "payment.succeeded").
   Se è il Biglietto VIP, il cliente va allo stesso webhook GHL del sito con ticket = vip,
   così arriva in GHL anche chi paga senza essersi iscritto gratis dallo stesso browser.
   Il telefono è la risposta alla domanda obbligatoria "Numero WhatsApp" del checkout: non è nel pagamento,
   sta nell'iscrizione, e la leggiamo con WHOP_API_KEY (senza chiave l'acquisto arriva lo stesso, senza telefono).
   Gestisce anche "membership.activated", ma su Whop va attivato un solo evento, sennò l'acquisto arriva due volte.
   Se su Vercel c'è WHOP_WEBHOOK_SECRET (il "Secret" del webhook su Whop) la firma viene controllata. */
const crypto = require("crypto");
const { cleanPhone, phoneFromAnswers, splitName, answersFromWhop } = require("./_telefono.js");

const GHL_WEBHOOK = "https://services.leadconnectorhq.com/hooks/yfFcdqju49Ta8CnyU0nO/webhook-trigger/d6f43765-e5a2-4251-ab1f-4b34d1366a4b";
const WHOP_ACCOUNT = "biz_EcRBCCmpcWE0SL";
const VIP_PRODUCT = "prod_vULKxWqiBAuZF";

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/* Standard Webhooks: HMAC-SHA256 di "id.timestamp.body", in base64, nell'header webhook-signature ("v1,<firma>") */
function signatureOk(raw, headers, secret) {
  const id = headers["webhook-id"], ts = headers["webhook-timestamp"], sigHeader = headers["webhook-signature"];
  if (!id || !ts || !sigHeader) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const signed = Buffer.concat([Buffer.from(`${id}.${ts}.`), raw]);
  const keys = [Buffer.from(secret, "utf8")];
  const bare = secret.replace(/^(whsec_|ws_)/, "");
  if (bare) keys.push(Buffer.from(bare, "base64"));
  const sent = String(sigHeader).split(" ").map(s => s.split(",")[1]).filter(Boolean);
  return keys.some(key => {
    const expected = crypto.createHmac("sha256", key).update(signed).digest("base64");
    return sent.some(s => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  });
}

function reply(res, code, text) { res.statusCode = code; res.setHeader("content-type", "text/plain; charset=utf-8"); res.end(text); }

module.exports = async (req, res) => {
  if (req.method !== "POST") return reply(res, 200, "ok");
  const raw = await readRaw(req);

  const secret = process.env.WHOP_WEBHOOK_SECRET;
  if (secret && !signatureOk(raw, req.headers, secret)) return reply(res, 401, "firma non valida");

  let event;
  try { event = JSON.parse(raw.toString("utf8")); } catch (e) { return reply(res, 400, "json non valido"); }

  const type = event.type;
  if (type !== "membership.activated" && type !== "payment.succeeded") return reply(res, 200, "evento ignorato");

  const p = event.data || {};
  const account = event.account_id || event.company_id || (p.company && p.company.id) || "";
  if (account && account !== WHOP_ACCOUNT) return reply(res, 200, "altro account");
  if (p.product && p.product.id && p.product.id !== VIP_PRODUCT) return reply(res, 200, "altro prodotto");

  const isMembership = type === "membership.activated";
  const user = p.user || {};
  const name = splitName(user.name || (p.billing_address && p.billing_address.name));
  let phone = phoneFromAnswers(p.custom_field_responses) || cleanPhone(p.customer_phone || (p.member && p.member.phone) || (p.membership && p.membership.phone_number));
  if (!phone && !isMembership && p.membership && p.membership.id) phone = phoneFromAnswers(await answersFromWhop(p.membership.id));
  const body = new URLSearchParams({
    full_name: name.full_name,
    first_name: name.first_name,
    last_name: name.last_name,
    email: String(user.email || "").trim(),
    phone,
    variante: "B",
    evento: "La morte del personal brand",
    ticket: "vip",
    tipo: "acquisto_vip",
    fonte: "whop_webhook",
    whop_evento: type,
    whop_payment: isMembership ? "" : (p.id || ""),
    whop_membership: isMembership ? (p.id || "") : ((p.membership && p.membership.id) || ""),
    whop_status: p.status || "",
    whop_plan: (p.plan && p.plan.id) || "",
    whop_amount: isMembership ? String(p.initial_price_paid || "") : (p.total != null ? String(p.total) : ""),
    whop_currency: p.currency || ""
  });
  if (!body.get("email") && !body.get("phone")) return reply(res, 200, "senza email né telefono");

  try {
    const r = await fetch(GHL_WEBHOOK, { method: "POST", body });
    return reply(res, r.ok ? 200 : 502, r.ok ? "inviato a GHL" : "GHL ha risposto " + r.status);
  } catch (e) {
    return reply(res, 502, "GHL non raggiungibile");
  }
};
