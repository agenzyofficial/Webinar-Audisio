/* Telefono dal checkout Whop: risposta alla domanda "Numero WhatsApp" (custom_field_responses).
   Il file inizia con "_" quindi Vercel non lo pubblica come indirizzo: lo usano whop.js e whop-cliente.js. */

/* Numero scritto a mano → formato +39…; senza prefisso, un cellulare italiano (3xx) prende +39 */
function cleanPhone(v) {
  let p = String(v || "").trim().replace(/[^\d+]/g, "");
  if (p.startsWith("00")) p = "+" + p.slice(2);
  if (!p.startsWith("+") && /^3\d{8,9}$/.test(p)) p = "+39" + p;
  return p;
}

/* Risposta alla domanda sul numero (o la prima che sembra un numero) */
function phoneFromAnswers(list) {
  const answers = Array.isArray(list) ? list : [];
  const byQuestion = answers.find(r => /whats|telefon|cellular|phone|numero/i.test((r && r.question) || ""));
  const looksLike = answers.find(r => /^\+?[\d\s().-]{8,}$/.test(String((r && r.answer) || "").trim()));
  return cleanPhone((byQuestion || looksLike || {}).answer);
}

/* "Andrea Audisio" → nome e cognome */
function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  return { full_name: parts.join(" "), first_name: parts[0] || "", last_name: parts.slice(1).join(" ") };
}

/* Risposte alle domande del checkout di un'iscrizione Whop; serve WHOP_API_KEY su Vercel, senza chiave torna vuoto */
async function answersFromWhop(membershipId) {
  const key = process.env.WHOP_API_KEY;
  if (!key || !membershipId) return [];
  try {
    const r = await fetch("https://api.whop.com/api/v1/memberships/" + encodeURIComponent(membershipId), { headers: { Authorization: "Bearer " + key } });
    return r.ok ? ((await r.json()).custom_field_responses || []) : [];
  } catch (e) { return []; }
}

module.exports = { cleanPhone, phoneFromAnswers, splitName, answersFromWhop };
