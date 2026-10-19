// Validates a new hospital's full setup. Nothing is copied from another
// hospital or filled from defaults: every setting a hospital runs on must be
// entered explicitly. Limits mirror System Settings.
const LEAVE_TYPES = [
  "Sick",
  "Annual",
  "Emergency",
  "Maternity",
  "Public Holiday",
  "Study Leave",
  "Compassionate Leave",
  "Leave of Absence",
];
const ENTITLEMENT_TYPES = ["Annual", "Study Leave", "Compassionate Leave", "Maternity", "Sick"];
const DEADLINE_KEYS = [
  "leave_closure_days",
  "generate_days",
  "edit_close_days",
  "publish_deadline_days",
  "revert_grace_days",
];
const ROTA_JOBS = ["auto_generate", "auto_submit", "auto_publish"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLE_KEY = /^[a-z][a-z0-9_]{1,49}$/;

function validateHospitalSetup(body, { roleKeys }) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  const obj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const int = (v, path, min, max) => {
    if (!Number.isInteger(v) || v < min || v > max)
      add(path, `Enter a whole number from ${min} to ${max}`);
    return v;
  };
  const text = (v, path, max) => {
    if (typeof v !== "string" || !v.trim() || v.trim().length > max)
      add(path, `Required (up to ${max} characters)`);
    return typeof v === "string" ? v.trim() : "";
  };
  if (!obj(body)) return { errors: [{ path: "", message: "Setup details are required" }] };

  // Roles the hospital uses: catalogue roles it enables plus roles created for it.
  // Administrator is always included.
  const roleSetup = obj(body.roles) ? body.roles : {};
  const enabled = Array.isArray(roleSetup.enabled) ? roleSetup.enabled : [];
  if (enabled.some((r) => typeof r !== "string" || !roleKeys.has(r)))
    add("roles.enabled", "Choose roles from the catalogue");
  const custom = Array.isArray(roleSetup.custom) ? roleSetup.custom : [];
  const customRoles = custom.map((r, i) => {
    const p = `roles.custom[${i}]`;
    const key = typeof r?.key === "string" ? r.key.trim() : "";
    if (!ROLE_KEY.test(key)) add(`${p}.key`, "Key must be lowercase snake_case, 2-50 characters");
    else if (roleKeys.has(key)) add(`${p}.key`, "This role key is already in use");
    return {
      key,
      label: text(r?.label, `${p}.label`, 80),
      description: typeof r?.description === "string" ? r.description.trim().slice(0, 300) : "",
    };
  });
  if (new Set(customRoles.map((r) => r.key)).size !== customRoles.length)
    add("roles.custom", "Role keys must be unique");
  const hospitalRoles = [...new Set(["admin", ...enabled, ...customRoles.map((r) => r.key)])];
  if (hospitalRoles.length < 2) add("roles", "Choose at least one role besides Administrator");
  const allowed = new Set(hospitalRoles);
  const roles = (list, path) => {
    if (!Array.isArray(list) || list.some((r) => typeof r !== "string" || !allowed.has(r)))
      add(path, "Use this hospital's roles only");
    // Administrators always keep access.
    return [...new Set(["admin", ...(Array.isArray(list) ? list : [])])];
  };

  const name = text(body.name, "name", 160);

  const gps = obj(body.gps) ? body.gps : {};
  int(gps.radius_m, "gps.radius_m", 50, 10000);
  const facilities = {};
  const sites = Array.isArray(gps.sites) ? gps.sites : [];
  if (!sites.length || sites.length > 50) add("gps.sites", "Add at least one site (up to 50)");
  sites.forEach((site, i) => {
    const p = `gps.sites[${i}]`;
    const siteName = text(site?.name, `${p}.name`, 80);
    if (siteName && Object.keys(facilities).some((n) => n.toLowerCase() === siteName.toLowerCase()))
      add(`${p}.name`, "Site names must be unique");
    const locations = Array.isArray(site?.locations) ? site.locations : [];
    if (!locations.length || locations.length > 10)
      add(`${p}.locations`, "Add at least one GPS location (up to 10)");
    facilities[siteName] = locations.map((loc, j) => {
      const q = `${p}.locations[${j}]`;
      const lat = Number(loc?.lat);
      const lng = Number(loc?.lng);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90)
        add(`${q}.lat`, "Latitude must be -90 to 90");
      if (!Number.isFinite(lng) || lng < -180 || lng > 180)
        add(`${q}.lng`, "Longitude must be -180 to 180");
      return { label: text(loc?.label, `${q}.label`, 120), lat, lng };
    });
  });

  const security = obj(body.security) ? body.security : {};
  int(security.min_password_length, "security.min_password_length", 4, 64);
  int(security.password_expiry_days, "security.password_expiry_days", 1, 365);
  int(security.idle_timeout_minutes, "security.idle_timeout_minutes", 5, 480);

  const leave = obj(body.leave) ? body.leave : {};
  int(leave.sick_emergency_max_days, "leave.sick_emergency_max_days", 1, 90);
  int(leave.shift_switch_min_notice_hours, "leave.shift_switch_min_notice_hours", 0, 720);
  const grace = Array.isArray(leave.grace_leave_types) ? leave.grace_leave_types : [];
  if (
    !grace.length ||
    grace.some((t) => !LEAVE_TYPES.includes(t)) ||
    new Set(grace).size !== grace.length
  )
    add("leave.grace_leave_types", "Choose at least one leave type");
  const entitlements = obj(leave.entitlements) ? leave.entitlements : {};
  for (const type of ENTITLEMENT_TYPES)
    int(entitlements[type], `leave.entitlements.${type}`, 0, 366);
  if (Object.keys(entitlements).some((t) => !ENTITLEMENT_TYPES.includes(t)))
    add("leave.entitlements", "Unknown leave type");

  const rota = obj(body.rota) ? body.rota : {};
  const deadlines = obj(rota.deadlines) ? rota.deadlines : {};
  for (const key of DEADLINE_KEYS) int(deadlines[key], `rota.deadlines.${key}`, 1, 90);
  if (
    !(
      deadlines.leave_closure_days >= deadlines.generate_days &&
      deadlines.generate_days >= deadlines.edit_close_days &&
      deadlines.edit_close_days >= deadlines.publish_deadline_days
    )
  )
    add(
      "rota.deadlines",
      "Keep the order: leave closure ≥ auto-generate ≥ edit closes ≥ auto-publish",
    );
  const jobs = obj(rota.jobs_paused) ? rota.jobs_paused : {};
  for (const key of ROTA_JOBS)
    if (typeof jobs[key] !== "boolean") add(`rota.jobs_paused.${key}`, "Choose on or off");

  const reminders = obj(body.reminders) ? body.reminders : {};
  int(reminders.missed_shift_hours, "reminders.missed_shift_hours", 1, 24);
  int(reminders.upcoming_shift_minutes, "reminders.upcoming_shift_minutes", 1, 120);

  const permissions = obj(body.permissions) ? body.permissions : {};
  const capabilities = Array.isArray(permissions.capabilities) ? permissions.capabilities : [];
  if (!capabilities.length) add("permissions.capabilities", "Set the permissions matrix");
  const seen = new Set();
  const capabilityValue = capabilities.map((c, i) => {
    if (typeof c?.key !== "string" || !/^[a-z_]{1,64}$/.test(c.key) || seen.has(c.key))
      add(`permissions.capabilities[${i}].key`, "Invalid or duplicate permission");
    seen.add(c?.key);
    return { key: c?.key, roles: roles(c?.roles, `permissions.capabilities[${i}].roles`) };
  });
  const menu = obj(permissions.menu_permissions) ? permissions.menu_permissions : null;
  if (!menu || !Object.keys(menu).length) add("permissions.menu_permissions", "Set menu access");
  const menuValue = {};
  for (const [path, list] of Object.entries(menu ?? {})) {
    if (!/^\/[a-z-]*$/.test(path)) add("permissions.menu_permissions", `Unknown page ${path}`);
    menuValue[path] = roles(list, `permissions.menu_permissions.${path}`);
  }

  const admin = obj(body.admin) ? body.admin : {};
  const adminName = text(admin.full_name, "admin.full_name", 120);
  const adminEmail = typeof admin.email === "string" ? admin.email.trim().toLowerCase() : "";
  if (!EMAIL.test(adminEmail) || adminEmail.length > 254)
    add("admin.email", "Enter a valid email address");

  return {
    errors,
    name,
    admin: { full_name: adminName, email: adminEmail },
    roles: { keys: hospitalRoles, custom: customRoles },
    settings: [
      ["gps_settings", { radius_m: gps.radius_m, facilities }],
      ["min_password_length", security.min_password_length],
      ["password_expiry_days", security.password_expiry_days],
      ["idle_timeout_minutes", security.idle_timeout_minutes],
      ["sick_emergency_max_days", leave.sick_emergency_max_days],
      ["shift_switch_min_notice_hours", leave.shift_switch_min_notice_hours],
      ["grace_leave_types", grace],
      [
        "leave_entitlement_defaults",
        Object.fromEntries(ENTITLEMENT_TYPES.map((t) => [t, entitlements[t]])),
      ],
      ["rota_deadlines", Object.fromEntries(DEADLINE_KEYS.map((k) => [k, deadlines[k]]))],
      ["rota_jobs_paused", Object.fromEntries(ROTA_JOBS.map((k) => [k, jobs[k]]))],
      [
        "shift_reminder_settings",
        {
          missed_shift_hours: reminders.missed_shift_hours,
          upcoming_shift_minutes: reminders.upcoming_shift_minutes,
        },
      ],
      ["capabilities", capabilityValue],
      ["menu_permissions", menuValue],
    ],
  };
}

module.exports = { validateHospitalSetup, LEAVE_TYPES, ENTITLEMENT_TYPES };
