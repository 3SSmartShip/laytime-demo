// The signed-in user as the browser sees it.
function me(u, amr, perms) {
  return {
    id: u.id,
    loginId: u.login_id,
    email: u.email || null,
    mobile: u.mobile || null,
    name: u.name,
    role: u.role,
    tenantId: u.tenant_id,
    tenantName: u.tenant_name || null,
    mustChangePassword: u.must_change_password,
    signedInWith: amr === 'otp' ? 'otp' : 'password',
    perms: perms || null,
  };
}
module.exports = { me };
