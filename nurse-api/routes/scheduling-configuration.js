const router = require("express").Router();
const pool = require("../db");
const { requireCapability } = require("../middleware/capability");
const {
  createSchedulingConfigurationService,
  ConfigurationError,
} = require("../lib/scheduling-configuration-service");
const { activeRoleGroups } = require("../lib/role-groups");
const { validDate } = require("../lib/configured-scheduler");
const service = createSchedulingConfigurationService(pool);
const view = () =>
  requireCapability("view_scheduling_configuration", ["admin", "cno", "chief_matron"]);
const manage = () => requireCapability("manage_scheduling_configuration", ["admin", "cno"]);
const wrap =
  (fn, status = 200) =>
  async (req, res, next) => {
    try {
      res.status(status).json(await fn(req));
    } catch (error) {
      if (error instanceof ConfigurationError)
        return res
          .status(error.status)
          .json({ error: error.message, ...(error.details ? { errors: error.details } : {}) });
      next(error);
    }
  };

// Role-to-group mapping of every active configuration, for Rota/Approvals grouping.
// Any signed-in user may read it: it exposes role names and groups only.
router.get(
  "/role-groups",
  wrap(async (req) => {
    const date = req.query.date;
    if (!validDate(date)) throw new ConfigurationError(400, "Use a valid date");
    return { facilities: await activeRoleGroups(pool, date) };
  }),
);
router.get(
  "/facilities",
  view(),
  wrap((req) => service.listFacilities(req.user.userId)),
);
router.get(
  "/facilities/:facilityId/defaults",
  view(),
  wrap((req) => service.defaults(req.user.userId, req.params.facilityId)),
);
router.get(
  "/facilities/:facilityId/versions",
  view(),
  wrap((req) => service.listVersions(req.user.userId, req.params.facilityId)),
);
router.get(
  "/facilities/:facilityId/versions/:versionId",
  view(),
  wrap((req) => service.getVersion(req.user.userId, req.params.facilityId, req.params.versionId)),
);
router.post(
  "/facilities/:facilityId/validate",
  manage(),
  wrap((req) => service.validate(req.user.userId, req.params.facilityId, req.body)),
);
router.post(
  "/facilities/:facilityId/versions",
  manage(),
  wrap((req) => service.create(req.user.userId, req.params.facilityId, req.body), 201),
);
router.put(
  "/facilities/:facilityId/versions/:versionId",
  manage(),
  wrap((req) =>
    service.update(req.user.userId, req.params.facilityId, req.params.versionId, req.body),
  ),
);

router.post(
  "/facilities/:facilityId/versions/:versionId/preview",
  manage(),
  wrap((req) =>
    service.preview(req.user.userId, req.params.facilityId, req.params.versionId, req.body),
  ),
);
router.post(
  "/facilities/:facilityId/versions/:versionId/runs",
  manage(),
  wrap(
    (req) =>
      service.saveRun(req.user.userId, req.params.facilityId, req.params.versionId, req.body),
    201,
  ),
);
router.get(
  "/facilities/:facilityId/runs",
  manage(),
  wrap((req) => service.listRuns(req.user.userId, req.params.facilityId)),
);
router.get(
  "/facilities/:facilityId/runs/:runId",
  manage(),
  wrap((req) => service.getRun(req.user.userId, req.params.facilityId, req.params.runId)),
);
// Applying a reviewed run is separate from preview/save and does not activate recurring generation.
router.post(
  "/facilities/:facilityId/runs/:runId/draft",
  (req, res, next) =>
    req.user.roles.includes("admin")
      ? next()
      : res.status(403).json({
          error:
            "Creating a facility draft from a saved run currently requires administrator access",
        }),
  manage(),
  requireCapability("edit_shift_assignments", ["admin", "head_nurse"]),
  wrap(
    (req) =>
      service.createDraftFromRun(
        req.user.userId,
        req.params.facilityId,
        req.params.runId,
        req.body,
      ),
    201,
  ),
);
const administrator = (req, res, next) =>
  req.user.roles.includes("admin")
    ? next()
    : res
        .status(403)
        .json({ error: "Scheduling activation and generation require administrator access" });
router.get(
  "/facilities/:facilityId/active",
  view(),
  wrap((req) => service.activePolicy(req.user.userId, req.params.facilityId, req.query.startDate)),
);
router.post(
  "/facilities/:facilityId/runs/:runId/activate",
  administrator,
  manage(),
  requireCapability("edit_shift_assignments", ["admin"]),
  wrap(
    (req) =>
      service.activateRun(req.user.userId, req.params.facilityId, req.params.runId, req.body),
    201,
  ),
);
router.post(
  "/facilities/:facilityId/pause",
  administrator,
  manage(),
  wrap((req) => service.pauseScheduling(req.user.userId, req.params.facilityId, req.body)),
);
router.post(
  "/facilities/:facilityId/generate-active",
  administrator,
  manage(),
  requireCapability("edit_shift_assignments", ["admin"]),
  wrap((req) => service.generateActive(req.user.userId, req.params.facilityId, req.body), 201),
);
router.get(
  "/facilities/:facilityId/add-staff-candidates",
  administrator,
  manage(),
  wrap((req) =>
    service.addStaffCandidates(req.user.userId, req.params.facilityId, req.query.startDate),
  ),
);
router.post(
  "/facilities/:facilityId/add-staff",
  administrator,
  manage(),
  requireCapability("edit_shift_assignments", ["admin"]),
  wrap((req) => service.addStaffToPeriod(req.user.userId, req.params.facilityId, req.body), 201),
);
module.exports = router;
