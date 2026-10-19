import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  roleGroupResolver,
  snapshotRoleGroups,
  legacyRoleGroup,
} = require("../nurse-api/lib/role-groups.js");

test("configured approval groups override legacy role-name matching per facility", () => {
  const groups = {
    Ikoyi: snapshotRoleGroups({
      roles: [
        { name: "Theatre Coordinator", approvalGroup: "head" },
        { name: "Matron", approvalGroup: "ward" },
      ],
    }),
  };
  const groupOf = roleGroupResolver(groups);
  assert.equal(groupOf("Theatre Coordinator", "Ikoyi"), "head");
  assert.equal(groupOf(" theatre coordinator ", "Ikoyi"), "head");
  assert.equal(groupOf("Matron", "Ikoyi"), null, "Configured ward scope wins");
  assert.equal(groupOf("Porter", "Ikoyi"), "porter", "Unlisted roles keep legacy matching");
  assert.equal(groupOf("Matron", "Ikeja"), "matron", "Unconfigured facilities stay legacy");
  assert.equal(groupOf("Theatre Coordinator", "Ikeja"), null);
});

test("legacy role groups match the existing role-name rules", () => {
  assert.equal(legacyRoleGroup("Matron"), "matron");
  assert.equal(legacyRoleGroup("Coverage Nurse - Day"), "head");
  assert.equal(legacyRoleGroup("Porter - Day"), "porter");
  assert.equal(legacyRoleGroup("Nurse Intern"), "intern");
  assert.equal(legacyRoleGroup("Nurse"), null);
});
