// Role × module permissions. The super admin sets a default for every organisation and can
// override it per organisation. Built-in defaults keep today's behaviour.
const Codes = require('../shared/codes');

const MODULES = [
  { key: 'sof_view', label: 'Statement of facts', desc: 'See SOF events and port times', applies: 'all' },
  { key: 'sof_record', label: 'Record SOF events', desc: 'Add, change and remove events. Stakeholders can only record the events their role allows.', applies: 'all', requires: ['sof_view'] },
  { key: 'sof_review', label: 'Confirm and dispute events', desc: 'Confirm, dispute and comment on events', applies: 'all', requires: ['sof_view'] },
  { key: 'documents', label: 'Documents and AI reading', desc: 'Upload SOFs and charter parties and add what was read', applies: 'all', requires: ['sof_view'] },
  { key: 'amounts', label: 'Rates and amounts', desc: 'Laytime calculation, rates, demurrage and despatch. Stakeholders also need "can see amounts" on the voyage.', applies: 'all' },
  { key: 'forecast', label: 'Live forecast', desc: 'When laytime expires and the expected result while the vessel works', applies: 'all' },
  { key: 'export', label: 'Excel export', desc: 'Download the laytime statement', applies: 'all', requires: ['amounts'] },
  { key: 'voyages_edit', label: 'Edit voyages and CP terms', desc: 'Create, change and delete voyages; laytime terms; CP treatment of SOF reasons', applies: 'tenant', requires: ['amounts'] },
  { key: 'stakeholders', label: 'Manage stakeholders', desc: 'Invite people and create logins for agents, masters and others', applies: 'tenant' },
  { key: 'users', label: 'Manage users', desc: 'Add, disable and reset users of the organisation', applies: ['admin'] },
  { key: 'audit', label: 'Activity log', desc: 'See who did what', applies: 'tenant' },
];
const BY_KEY = Object.fromEntries(MODULES.map(m => [m.key, m]));

const ROLES = [
  { key: 'admin', label: 'Admin', group: 'Organisation' },
  { key: 'member', label: 'Member', group: 'Organisation' },
  ...Object.entries(Codes.PARTY_ROLES).map(([key, label]) => ({ key, label, group: 'Stakeholders' })),
];
const ROLE_KEYS = ROLES.map(r => r.key);
const TENANT_ROLES = ['admin', 'member'];

function applies(m, role) {
  if (m.applies === 'all') return true;
  if (m.applies === 'tenant') return TENANT_ROLES.includes(role);
  return m.applies.includes(role);
}

function builtIn(role, key) {
  if (role === 'admin') return true;
  if (role === 'member') return !['users', 'audit'].includes(key);
  // stakeholders: owners, charterers and brokers review; they don't record
  if (key === 'sof_record') return !['owner', 'charterer', 'broker'].includes(role);
  return true;
}

function resolveDeps(out) {
  for (let pass = 0; pass < 3; pass++) {
    MODULES.forEach(m => { if (out[m.key] && (m.requires || []).some(r => !out[r])) out[m.key] = false; });
  }
  return out;
}

const ALL = Object.fromEntries(MODULES.map(m => [m.key, true]));

// Effective permissions for a role in an organisation.
async function effective(db, tenantId, role) {
  if (role === 'superadmin') return { ...ALL };
  const { rows } = await db.query(
    'SELECT tenant_id, module, enabled FROM role_permissions WHERE role = $1 AND (tenant_id IS NULL OR tenant_id = $2)', [role, tenantId || null]);
  const g = {}, t = {};
  rows.forEach(r => { (r.tenant_id ? t : g)[r.module] = r.enabled; });
  const out = {};
  MODULES.forEach(m => {
    if (!applies(m, role)) { out[m.key] = false; return; }
    out[m.key] = t[m.key] ?? g[m.key] ?? builtIn(role, m.key);
  });
  return resolveDeps(out);
}

// Full matrix for the admin screen. scope: null (default for all) or a tenant id.
async function matrix(db, tenantId) {
  const { rows } = await db.query('SELECT tenant_id, role, module, enabled FROM role_permissions WHERE tenant_id IS NULL OR tenant_id = $1', [tenantId || null]);
  const cells = {};
  ROLES.forEach(r => {
    const g = {}, t = {};
    rows.filter(x => x.role === r.key).forEach(x => { (x.tenant_id ? t : g)[x.module] = x.enabled; });
    const raw = {};
    const c = {};
    MODULES.forEach(m => {
      if (!applies(m, r.key)) { c[m.key] = { applies: false }; return; }
      const def = g[m.key] ?? builtIn(r.key, m.key);
      const val = tenantId ? (t[m.key] ?? def) : def;
      raw[m.key] = val;
      c[m.key] = { applies: true, value: val, source: tenantId && t[m.key] !== undefined ? 'organisation' : g[m.key] !== undefined ? 'default' : 'built-in', inherited: def };
    });
    const eff = resolveDeps({ ...raw });
    MODULES.forEach(m => { if (c[m.key].applies) c[m.key].blocked = raw[m.key] && !eff[m.key]; });
    cells[r.key] = c;
  });
  return { modules: MODULES.map(({ key, label, desc, requires }) => ({ key, label, desc, requires: requires || [] })), roles: ROLES, cells };
}

module.exports = { MODULES, BY_KEY, ROLES, ROLE_KEYS, TENANT_ROLES, applies, effective, matrix, ALL };
