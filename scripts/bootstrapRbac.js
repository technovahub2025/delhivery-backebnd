const mongoose = require("mongoose");
const User = require("../model/model");
const RbacPolicy = require("../model/rbacPolicy");
const RbacAuditEvent = require("../model/rbacAuditEvent");
const { validateRoleMap } = require("../utils/rbacAuthorization");

async function main() {
  const userId = process.argv[2];
  const roleKey = process.argv[3];
  const approvalReference = process.env.RBAC_APPROVAL_REFERENCE?.trim();
  if (process.env.RBAC_BOOTSTRAP_APPROVED !== "true" || !approvalReference || !mongoose.isValidObjectId(userId) || !roleKey) {
    throw new Error("Requires an approved policy, RBAC_APPROVAL_REFERENCE, and exactly one valid user ID and role key.");
  }
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required.");
  let rawPolicy;
  try { rawPolicy = JSON.parse(process.env.RBAC_APPROVED_ROLE_POLICY_JSON || ""); }
  catch { throw new Error("RBAC_APPROVED_ROLE_POLICY_JSON must contain valid JSON."); }
  const roles = validateRoleMap(rawPolicy);
  if (!roles || !roles[roleKey]?.includes("users.permissions.manage")) {
    throw new Error("Approved policy must define the selected role with users.permissions.manage.");
  }

  await mongoose.connect(process.env.MONGO_URI);
  const session = await mongoose.startSession();
  const actorId = `approved-bootstrap:${approvalReference.slice(0, 100)}`;
  try {
    await session.withTransaction(async () => {
      const activePolicy = await RbacPolicy.findOne({ key: "active" }).session(session);
      if (activePolicy) throw new Error("An RBAC policy is already active; use the audited administrator workflow.");
      const user = await User.findById(userId).session(session);
      if (!user) throw new Error("The selected user does not exist.");
      if (user.roleKey) throw new Error("The selected user already has a role; refusing to replace it.");
      if (user.active === false) throw new Error("The selected user is inactive.");
      await RbacPolicy.create([{ key: "active", revision: 1, roles, updatedBy: actorId }], { session });
      user.roleKey = roleKey;
      user.authzVersion = Number(user.authzVersion || 0) + 1;
      await user.save({ session });
      await RbacAuditEvent.create([
        { actorId, targetId: null, action: "rbac.policy.update", outcome: "succeeded", before: { revision: null, roles: null }, after: { revision: 1, roles }, reason: `Approved bootstrap: ${approvalReference}` },
        { actorId, targetId: String(user._id), action: "user.role.assign", outcome: "succeeded", before: { role: null }, after: { role: roleKey }, reason: `Approved initial role assignment: ${approvalReference}` },
      ], { session });
    });
  } finally {
    await session.endSession();
    await mongoose.disconnect();
  }
  process.stdout.write(`RBAC policy activated at revision 1; role ${roleKey} assigned to one approved user.\n`);
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
