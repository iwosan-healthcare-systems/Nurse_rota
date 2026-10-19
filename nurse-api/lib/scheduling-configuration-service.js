const { createHash } = require("node:crypto");
const { persistRotaDraft, DraftConflict } = require("./persist-rota-draft");
const { createPolicyService, isLiveCompatible } = require("./scheduling-policy");
const {
  UUID,
  validateConfiguration,
  seedConfiguration,
  configurationWarnings,
} = require("./scheduling-configuration");
const {
  generateConfiguredPreview,
  PreviewError,
  validDate,
  addDays,
} = require("./configured-scheduler");

class ConfigurationError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
const fail = (status, message, details) => {
  throw new ConfigurationError(status, message, details);
};
const assertId = (value) => {
  if (typeof value !== "string" || !UUID.test(value)) fail(400, "Invalid identifier");
};
const assertBody = (body, fields) => {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !fields.includes(k))
  )
    fail(400, "Invalid request fields");
};

function createSchedulingConfigurationService(pool) {
  async function facilityFor(db, userId, facilityId, lock = false) {
    assertId(facilityId);
    const { rows } = await db.query(
      `SELECT f.* FROM scheduling_facilities f
       JOIN scheduling_facility_access a ON a.facility_id = f.id
       WHERE f.id = $1 AND a.user_id = $2 ${lock ? "FOR UPDATE OF f" : ""}`,
      [facilityId, userId],
    );
    if (!rows[0]) fail(404, "Facility not found or not accessible");
    return rows[0];
  }
  async function wardsFor(db, facility) {
    const { rows } = await db.query(
      `SELECT id, name, min_morning_nurses, min_morning_na, min_night_nurses, min_night_na
       FROM wards WHERE facility = $1 ORDER BY id`,
      [facility.legacy_facility],
    );
    return rows;
  }
  function checked(config, wards) {
    const result = validateConfiguration(config, wards);
    if (!result.valid) fail(422, "Invalid scheduling configuration", result.errors);
    return config;
  }
  const describe = (row) => ({
    ...row,
    activationAvailable: true,
    warnings: configurationWarnings(row.configuration),
  });
  async function transaction(fn, readOnly = false, snapshot = false) {
    const client = await pool.connect();
    try {
      await client.query(
        readOnly
          ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
          : snapshot
            ? "BEGIN ISOLATION LEVEL REPEATABLE READ"
            : "BEGIN",
      );
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "40001" || error.code === "40P01")
        fail(409, "Scheduling inputs changed during this request; reload and retry");
      throw error;
    } finally {
      client.release();
    }
  }
  async function audit(db, userId, action, row) {
    await db.query(`INSERT INTO audit_logs (action, actor_id, target) VALUES ($1, $2, $3)`, [
      action,
      userId,
      `Scheduling configuration ${row.id}; facility ${row.facility_id}; version ${row.version}; revision ${row.revision}`,
    ]);
  }
  async function generateRun(
    userId,
    facilityId,
    versionId,
    body,
    save = false,
    dbOverride = null,
    context = {},
  ) {
    assertId(versionId);
    assertBody(body, ["revision", "startDate", "anchorDate"]);
    if (!Number.isInteger(body.revision) || body.revision < 1)
      fail(400, "A positive revision is required");
    if (
      !validDate(body.startDate) ||
      (body.anchorDate !== undefined &&
        (!validDate(body.anchorDate) || body.anchorDate > body.startDate))
    )
      fail(400, "Use a valid start date and an anchor on or before it");
    const operation = async (db) => {
      // Only trusted policy code supplies context; request bodies cannot override it.
      const facility = context.facility ?? (await facilityFor(db, userId, facilityId));
      const { rows: versions } = context.version
        ? { rows: [context.version] }
        : await db.query(
            "SELECT * FROM scheduling_config_versions WHERE id = $1 AND facility_id = $2",
            [versionId, facilityId],
          );
      const version = versions[0];
      if (!version) fail(404, "Configuration not found");
      if (version.revision !== body.revision)
        fail(409, "Configuration changed; reload before previewing");
      const wards = await wardsFor(db, facility);
      checked(version.configuration, wards);
      const { rows: nurses } = await db.query(
        "SELECT id, name, role, ward, facility, target_hours, is_active FROM nurses WHERE facility = $1 AND is_active = true ORDER BY id LIMIT 1001",
        [facility.legacy_facility],
      );
      if (nurses.length > 1000) fail(422, "Preview supports up to 1,000 active staff per facility");
      const ids = nurses.map((n) => n.id);
      const { rows: epochs } = await db.query(
        "SELECT MIN(shift_date)::text AS anchor FROM shift_assignments WHERE nurse_id = ANY($1::uuid[]) AND status = 'published' AND shift_date < $2",
        [ids, body.startDate],
      );
      const anchorDate = body.anchorDate ?? epochs[0]?.anchor ?? body.startDate;
      const { rows: previousAssignments } = await db.query(
        "SELECT nurse_id, shift_date::text, shift, pre_leave_shift FROM shift_assignments WHERE nurse_id = ANY($1::uuid[]) AND status = 'published' AND shift_date BETWEEN $2 AND $3 ORDER BY shift_date,nurse_id",
        [ids, addDays(body.startDate, -366), addDays(body.startDate, -1)],
      );
      const { rows: leave } = await db.query(
        "SELECT nurse_id, from_date::text, to_date::text, status, type FROM leave_requests WHERE nurse_id = ANY($1::uuid[]) AND status = 'Approved' AND from_date <= $3 AND to_date >= $2 ORDER BY nurse_id,from_date,to_date,type",
        [ids, body.startDate, addDays(body.startDate, 27)],
      );
      try {
        const inputs = {
          facility,
          wards,
          nurses,
          leave,
          previousAssignments,
          startDate: body.startDate,
          anchorDate,
        };
        const result = {
          ...generateConfiguredPreview({
            configuration: version.configuration,
            facility,
            wards,
            nurses,
            leave,
            previousAssignments,
            startDate: body.startDate,
            anchorDate,
          }),
          configurationId: version.id,
          activationAvailable: true,
          configurationVersion: version.version,
          configurationRevision: version.revision,
          generatedAt: new Date().toISOString(),
          shiftDefinitions: version.configuration.shifts,
          wardDefinitions: wards.map((w) => ({ id: w.id, name: w.name })),
        };
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              configuration: version.configuration,
              inputs,
              engineVersion: result.engineVersion,
            }),
          )
          .digest("hex");
        if (!save) return { ...result, inputFingerprint: fingerprint };
        const {
          rows: [run],
        } = await db.query(
          `INSERT INTO scheduling_runs (organization_id,facility_id,configuration_id,configuration_version,configuration_revision,start_date,end_date,engine_version,input_fingerprint,configuration_snapshot,input_snapshot,result_snapshot,created_by,generation_source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14) RETURNING id, created_at`,
          [
            facility.organization_id,
            facilityId,
            version.id,
            version.version,
            version.revision,
            result.startDate,
            result.endDate,
            result.engineVersion,
            fingerprint,
            JSON.stringify(version.configuration),
            JSON.stringify(inputs),
            JSON.stringify(result),
            userId ?? null,
            context.automatic ? "automatic" : "manual",
          ],
        );
        await db.query("INSERT INTO audit_logs (action,actor_id,target) VALUES ($1,$2,$3)", [
          context.automatic ? "Automatic scheduling run saved" : "Scheduling review run saved",
          userId ?? null,
          `Run ${run.id}; facility ${facilityId}; configuration ${version.id}; revision ${version.revision}`,
        ]);
        return {
          ...result,
          runId: run.id,
          savedAt: run.created_at,
          inputFingerprint: fingerprint,
        };
      } catch (error) {
        if (error instanceof PreviewError) fail(422, error.message, error.errors);
        throw error;
      }
    };
    return dbOverride ? operation(dbOverride) : transaction(operation, !save, save);
  }
  return {
    ...createPolicyService({
      pool,
      transaction,
      facilityFor,
      generateRun,
      fail,
      assertId,
      assertBody,
    }),
    async createDraftFromRun(userId, facilityId, runId, body) {
      assertId(runId);
      assertBody(body, []);
      return transaction(
        async (db) => {
          const facility = await facilityFor(db, userId, facilityId, true);
          const {
            rows: [run],
          } = await db.query("SELECT * FROM scheduling_runs WHERE id=$1 AND facility_id=$2", [
            runId,
            facilityId,
          ]);
          if (!run) fail(404, "Saved run not found");
          const config = run.configuration_snapshot;
          if (!isLiveCompatible(config))
            fail(422, "Only the Africa/Lagos timezone can be used for live drafts");
          const start = run.result_snapshot.startDate,
            end = run.result_snapshot.endDate;
          const policy = await db.query(
            "SELECT 1 FROM scheduling_policy_events WHERE facility_id=$1 AND effective_from<=$2 LIMIT 1",
            [facilityId, end],
          );
          if (policy.rows.length)
            fail(
              409,
              "This period has a scheduling policy. Generate using the active configuration instead.",
            );
          const ids = run.input_snapshot.nurses.map((n) => n.id);
          await db.query("SELECT id FROM nurses WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [
            ids,
          ]);
          const pending = await db.query(
            "SELECT id FROM leave_requests WHERE nurse_id=ANY($1::uuid[]) AND status='Pending' AND from_date<=$3 AND to_date>=$2 LIMIT 1",
            [ids, start, end],
          );
          if (pending.rows.length) fail(409, "Resolve pending leave before creating this draft");
          const fresh = await generateRun(
            userId,
            facilityId,
            run.configuration_id,
            {
              revision: run.configuration_revision,
              startDate: start,
              anchorDate: run.result_snapshot.anchorDate,
            },
            false,
            db,
          );
          if (fresh.inputFingerprint !== run.input_fingerprint)
            fail(
              409,
              "Staff, leave, history or settings changed. Generate and review a new saved run.",
            );
          if (fresh.hasBlockingIssues)
            fail(
              422,
              "Resolve preview issues before creating a draft",
              fresh.diagnostics.filter((d) => d.severity === "error"),
            );
          const wards = new Map(run.input_snapshot.wards.map((w) => [w.id, w.name]));
          const assignments = fresh.assignments.map((a) => ({
            nurse_id: a.nurseId,
            shift_date: a.date,
            shift: a.shift,
            ward: wards.get(a.wardId) ?? null,
            pre_leave_shift: a.shift === "LEAVE" ? a.plannedShift : null,
            leave_type: a.leaveType,
          }));
          try {
            const written = await persistRotaDraft(db, {
              nurseIds: ids,
              startDate: start,
              endDate: end,
              assignments,
              actorName: "Configured scheduling",
              runId,
            });
            await db.query("INSERT INTO audit_logs (action,actor_id,target) VALUES ($1,$2,$3)", [
              "Configured rota draft created",
              userId,
              `Run ${runId}; facility ${facilityId}; ${start} to ${end}; ${written.written} cells`,
            ]);
            return { ...written, runId, activationAvailable: true };
          } catch (error) {
            if (error instanceof DraftConflict) fail(409, error.message);
            throw error;
          }
        },
        false,
        true,
      );
    },
    async preview(userId, facilityId, versionId, body) {
      return generateRun(userId, facilityId, versionId, body);
    },
    async saveRun(userId, facilityId, versionId, body) {
      return generateRun(userId, facilityId, versionId, body, true);
    },
    async listRuns(userId, facilityId) {
      await facilityFor(pool, userId, facilityId);
      const { rows } = await pool.query(
        "SELECT id, configuration_id, configuration_version, configuration_revision, start_date::text, end_date::text, created_at FROM scheduling_runs WHERE facility_id=$1 ORDER BY created_at DESC, id DESC LIMIT 100",
        [facilityId],
      );
      return { runs: rows, activationAvailable: true };
    },
    async getRun(userId, facilityId, runId) {
      assertId(runId);
      await facilityFor(pool, userId, facilityId);
      const {
        rows: [run],
      } = await pool.query(
        "SELECT id, created_at, input_fingerprint, result_snapshot FROM scheduling_runs WHERE id=$1 AND facility_id=$2",
        [runId, facilityId],
      );
      if (!run) fail(404, "Saved run not found");
      return {
        ...run.result_snapshot,
        activationAvailable: true,
        runId: run.id,
        savedAt: run.created_at,
        inputFingerprint: run.input_fingerprint,
      };
    },
    async listFacilities(userId) {
      // Locations created after migration 042 (new wards or staff with a new
      // facility name) join the existing organization, with the same initial
      // admin/CNO grants the migration gave. Existing grants are never widened.
      // Two statements: row-level security checks each access grant against the
      // facilities visible to the statement, which excludes rows it inserted itself.
      await transaction(async (db) => {
        const { rows: added } = await db.query(
          `INSERT INTO scheduling_facilities (name, legacy_facility)
           SELECT l.facility, l.facility
           FROM (SELECT facility FROM wards UNION SELECT facility FROM nurses) l
           WHERE l.facility IS NOT NULL AND btrim(l.facility) <> ''
             AND app_current_hospital() IS NOT NULL
           ON CONFLICT DO NOTHING
           RETURNING id`,
        );
        if (!added.length) return;
        await db.query(
          `INSERT INTO scheduling_facility_access (facility_id, user_id)
           SELECT a.id, ur.user_id FROM scheduling_facilities a
           CROSS JOIN user_roles ur WHERE a.id = ANY($1::uuid[]) AND ur.role::text IN ('admin', 'cno')
           UNION
           SELECT a.id, n.profile_id FROM scheduling_facilities a
           JOIN nurses n ON n.facility = a.legacy_facility
           WHERE a.id = ANY($1::uuid[]) AND n.profile_id IS NOT NULL
           ON CONFLICT DO NOTHING`,
          [added.map((row) => row.id)],
        );
      });
      const { rows } = await pool.query(
        `SELECT f.id, f.organization_id, f.name, f.timezone FROM scheduling_facilities f
         JOIN scheduling_facility_access a ON a.facility_id = f.id
         WHERE a.user_id = $1 ORDER BY f.name`,
        [userId],
      );
      return { facilities: rows, activationAvailable: true };
    },
    async listVersions(userId, facilityId) {
      await facilityFor(pool, userId, facilityId);
      const { rows } = await pool.query(
        `SELECT id, facility_id, version, revision, status, created_at, updated_at
         FROM scheduling_config_versions WHERE facility_id = $1 ORDER BY version DESC LIMIT 100`,
        [facilityId],
      );
      return { versions: rows, activationAvailable: true };
    },
    async getVersion(userId, facilityId, versionId) {
      assertId(versionId);
      await facilityFor(pool, userId, facilityId);
      const { rows } = await pool.query(
        "SELECT * FROM scheduling_config_versions WHERE id = $1 AND facility_id = $2",
        [versionId, facilityId],
      );
      if (!rows[0]) fail(404, "Configuration not found");
      return describe(rows[0]);
    },
    async defaults(userId, facilityId) {
      const facility = await facilityFor(pool, userId, facilityId);
      const wards = await wardsFor(pool, facility);
      const { rows } = await pool.query(
        "SELECT DISTINCT role FROM nurses WHERE facility = $1 ORDER BY role",
        [facility.legacy_facility],
      );
      const configuration = checked(
        seedConfiguration(
          facility,
          wards,
          rows.map((r) => r.role),
        ),
        wards,
      );
      return {
        configuration,
        wards: wards.map((w) => ({ id: w.id, name: w.name })),
        activationAvailable: true,
        warnings: configurationWarnings(configuration),
      };
    },
    async validate(userId, facilityId, body) {
      assertBody(body, ["configuration"]);
      const facility = await facilityFor(pool, userId, facilityId);
      const result = validateConfiguration(body.configuration, await wardsFor(pool, facility));
      return {
        ...result,
        activationAvailable: true,
        warnings: result.valid ? configurationWarnings(body.configuration) : [],
      };
    },
    async create(userId, facilityId, body) {
      assertBody(body, ["configuration", "sourceVersionId"]);
      if (body.configuration !== undefined && body.sourceVersionId !== undefined)
        fail(400, "Choose configuration or sourceVersionId, not both");
      if (body.sourceVersionId !== undefined) assertId(body.sourceVersionId);
      return transaction(async (db) => {
        // Serialize version allocation for this facility across API workers.
        const facility = await facilityFor(db, userId, facilityId, true);
        const wards = await wardsFor(db, facility);
        let configuration = body.configuration;
        if (body.sourceVersionId !== undefined) {
          const { rows } = await db.query(
            "SELECT configuration FROM scheduling_config_versions WHERE id = $1 AND facility_id = $2",
            [body.sourceVersionId, facilityId],
          );
          if (!rows[0]) fail(404, "Source configuration not found");
          configuration = rows[0].configuration;
        } else if (configuration === undefined) {
          const { rows } = await db.query(
            "SELECT DISTINCT role FROM nurses WHERE facility = $1 ORDER BY role",
            [facility.legacy_facility],
          );
          configuration = seedConfiguration(
            facility,
            wards,
            rows.map((r) => r.role),
          );
        }
        checked(configuration, wards);
        const { rows } = await db.query(
          `INSERT INTO scheduling_config_versions
           (organization_id, facility_id, version, configuration, created_by, updated_by)
           SELECT $1, $2, COALESCE(MAX(version), 0) + 1, $3::jsonb, $4, $4
           FROM scheduling_config_versions WHERE facility_id = $2 RETURNING *`,
          [facility.organization_id, facilityId, JSON.stringify(configuration), userId],
        );
        await audit(db, userId, "Scheduling configuration draft created", rows[0]);
        return describe(rows[0]);
      });
    },
    async update(userId, facilityId, versionId, body) {
      assertId(versionId);
      assertBody(body, ["revision", "configuration"]);
      if (!Number.isInteger(body.revision) || body.revision < 1)
        fail(400, "A positive revision is required");
      return transaction(async (db) => {
        const facility = await facilityFor(db, userId, facilityId, true);
        const { rows } = await db.query(
          "SELECT * FROM scheduling_config_versions WHERE id = $1 AND facility_id = $2 FOR UPDATE",
          [versionId, facilityId],
        );
        const current = rows[0];
        if (!current) fail(404, "Configuration not found");
        if (current.status !== "draft") fail(409, "Only draft configurations may be edited");
        if (current.revision !== body.revision)
          fail(409, "Configuration changed; reload before saving");
        checked(body.configuration, await wardsFor(db, facility));
        const result = await db.query(
          `UPDATE scheduling_config_versions SET configuration = $1::jsonb, revision = revision + 1,
           updated_by = $2, updated_at = now() WHERE id = $3 AND facility_id = $4 RETURNING *`,
          [JSON.stringify(body.configuration), userId, versionId, facilityId],
        );
        await audit(db, userId, "Scheduling configuration draft updated", result.rows[0]);
        return describe(result.rows[0]);
      });
    },
  };
}

module.exports = { createSchedulingConfigurationService, ConfigurationError };
