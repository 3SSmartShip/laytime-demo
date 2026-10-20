// Who may do what on one voyage.
//  - users of the voyage's own organisation, and platform admins: everything ("manage")
//  - invited stakeholders: per their party role; commercial figures only if granted
const { query } = require('./db');
const { httpError } = require('./auth');
const Codes = require('../shared/codes');
const Perms = require('./permissions');

const COMMERCIAL_DEFAULT = { owner: true, charterer: true, broker: true };

async function voyageAccess(user, voyageId, db = { query }) {
  if (!/^[0-9a-f-]{36}$/i.test(String(voyageId))) throw httpError(404, 'Voyage not found.');
  const { rows } = await db.query(
    `SELECT v.*, t.name AS tenant_name FROM voyages v JOIN tenants t ON t.id = v.tenant_id WHERE v.id = $1`,
    [voyageId],
  );
  const voyage = rows[0];
  if (!voyage) throw httpError(404, 'Voyage not found.');
  if (user.role === 'superadmin' || (user.tenant_id && user.tenant_id === voyage.tenant_id)) {
    const perms = await Perms.effective(db, voyage.tenant_id, user.role);
    return {
      voyage,
      perms,
      manage: true,
      party: 'operator',
      partyLabel: voyage.tenant_name,
      commercial: perms.amounts,
      canRecord: () => perms.sof_record,
      canReview: perms.sof_review,
    };
  }
  const { rows: pr } = await db.query('SELECT * FROM voyage_participants WHERE voyage_id = $1 AND user_id = $2', [
    voyageId,
    user.id,
  ]);
  const p = pr[0];
  if (!p) throw httpError(404, 'Voyage not found.');
  // Stakeholders: the module settings for their role in the operator's organisation, then the voyage's own grants.
  const perms = await Perms.effective(db, voyage.tenant_id, p.party_role);
  return {
    voyage,
    perms,
    manage: false,
    party: p.party_role,
    partyLabel: Codes.PARTY_ROLES[p.party_role] || p.party_role,
    commercial: perms.amounts && p.can_see_commercials,
    canRecord: code => perms.sof_record && Codes.canRecord(p.party_role, code),
    canReview: perms.sof_review,
  };
}

// What a stakeholder without commercial access may see of the voyage document.
function redact(data) {
  return {
    vessel: data.vessel,
    cargo: data.cargo,
    owners: data.owners,
    charterers: data.charterers,
    active: 0,
    ports: data.ports.map(p => ({
      id: p.id,
      name: p.name,
      op: p.op,
      tz: p.tz,
      qty: p.qty,
      arrived: p.arrived,
      nor: p.nor,
      norAcc: p.norAcc,
      berthed: p.berthed,
      commenced: p.commenced,
      completed: p.completed,
      sailed: p.sailed,
      etc: p.etc,
    })),
  };
}

module.exports = { voyageAccess, redact, COMMERCIAL_DEFAULT };
