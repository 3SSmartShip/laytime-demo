// Mobile numbers are stored in international format (+919876543210).
const DEFAULT_CC = String(process.env.DEFAULT_COUNTRY_CODE || '91').replace(/\D/g, '');

function normalizeMobile(input) {
  if (input === undefined || input === null) return null;
  let s = String(input).trim();
  if (!s) return null;
  const plus = s.startsWith('+') || s.startsWith('00');
  let d = s.replace(/\D/g, '');
  if (s.startsWith('00')) d = d.slice(2);
  if (!plus) {
    if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    if (d.length === 10) d = DEFAULT_CC + d;
  }
  const e164 = `+${d}`;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : undefined; // undefined = present but invalid
}

function maskMobile(m) { return m ? `${m.slice(0, 3)}••••••${m.slice(-4)}` : ''; }
function maskEmail(e) {
  if (!e) return '';
  const [u, d] = e.split('@');
  return `${u.slice(0, 2)}${'•'.repeat(Math.max(1, u.length - 2))}@${d}`;
}
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());

module.exports = { normalizeMobile, maskMobile, maskEmail, isEmail };
