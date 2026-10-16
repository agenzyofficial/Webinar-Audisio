/* Dati del cliente per la pagina di grazie VIP: nome, cognome, email e WhatsApp del pagamento Whop appena fatto,
   così la scheda arriva già compilata e bloccata. Chiamata: /api/whop-cliente/?payment=pay_…
   Serve WHOP_API_KEY su Vercel (chiave API dell'account Whop). Risponde solo per il Biglietto VIP
   e per pagamenti delle ultime 48 ore. */
const { cleanPhone, phoneFromAnswers, splitName, answersFromWhop, API_VERSION } = require("./_telefono.js");

const VIP_PRODUCT = "prod_vULKxWqiBAuZF";
const API = "https://api.whop.com/api/v1";

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  const key = process.env.WHOP_API_KEY;
  if (!key) return send(res, 503, { error: "manca WHOP_API_KEY" });

  const id = new URL(req.url, "https://x").searchParams.get("payment") || "";
  if (!/^pay_[A-Za-z0-9]+$/.test(id)) return send(res, 400, { error: "pagamento non valido" });

  const get = async path => {
    const r = await fetch(API + path, { headers: { Authorization: "Bearer " + key, "Api-Version-Date": API_VERSION } });
    if (!r.ok) throw new Error(path.split("/")[1] + " " + r.status + " " + (await r.text().catch(() => "")).slice(0, 400));
    return r.json();
  };

  try {
    const pay = await get("/payments/" + id);
    const productId = (pay.product && pay.product.id) || pay.product_id;
    if (productId !== VIP_PRODUCT) return send(res, 404, { error: "altro prodotto" });
    const when = Date.parse(pay.paid_at || pay.created_at || "");
    if (!when || Date.now() - when > 48 * 3600 * 1000) return send(res, 404, { error: "pagamento vecchio" });

    const answers = await answersFromWhop((pay.membership && pay.membership.id) || pay.membership_id);

    const user = pay.user && typeof pay.user === "object" ? pay.user : {};
    const name = splitName(user.name || (pay.billing_address && pay.billing_address.name));
    const phone = phoneFromAnswers(answers) || cleanPhone(pay.customer_phone || (pay.membership && pay.membership.phone_number) || (pay.member && pay.member.phone));
    return send(res, 200, { first_name: name.first_name, last_name: name.last_name, email: String(user.email || pay.customer_email || "").trim(), phone });
  } catch (e) {
    return send(res, 502, { error: "Whop non risponde", dettaglio: String(e && e.message || "").slice(0, 500) });
  }
};
