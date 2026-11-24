const express = require("express");
const mongoose = require("mongoose");
const requireSession = require("../utils/requireSession");
const { validateRoleMap, readActivePolicy, createRbacAuthorization } = require("../utils/rbacAuthorization");
const User = require("../model/model");
const RbacPolicy = require("../model/rbacPolicy");
const RbacAuditEvent = require("../model/rbacAuditEvent");

function readQuery(query) { return query && typeof query.lean === "function" ? query.lean() : query; }

function createRbacRoutes({ UserModel = User, PolicyModel = RbacPolicy, AuditModel = RbacAuditEvent } = {}) {
  const router = express.Router();
  // The application-wide RBAC switch may remain disabled pending client
  // approval, while this administration surface still enforces its own
  // configured permissions so its permission checks always have an identity.
  router.use(requireSession, createRbacAuthorization({ UserModel, PolicyModel, enforce: true }));

  router.get("/users/:id/role", async (req, res) => {
    if (!req.authz?.permissions.includes("users.read")) return res.status(403).json({ success: false, code: "PERMISSION_DENIED", message: "Your assigned role does not allow this action." });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid user ID." });
    try {
      const query = UserModel.findById(req.params.id);
      const target = await readQuery(typeof query?.select === "function" ? query.select("name email roleKey active authzVersion") : query);
      return target ? res.json({ success: true, data: { user: { id: String(target._id), name: target.name, email: target.email, role: target.roleKey || null, active: target.active !== false } } }) : res.status(404).json({ success: false, message: "User not found." });
    } catch {
      return res.status(503).json({ success: false, message: "User role could not be loaded." });
    }
  });

  router.patch("/users/:id/role", async (req, res) => {
    if (!req.authz?.permissions.includes("users.permissions.manage")) return res.status(403).json({ success: false, code: "PERMISSION_DENIED", message: "Your assigned role does not allow this action." });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid user ID." });
    const roleKey = req.body?.role;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (typeof roleKey !== "string" || !reason || reason.length > 500 || Object.keys(req.body || {}).some(key => !["role", "reason"].includes(key))) {
      return res.status(400).json({ success: false, message: "A configured role and reason are required." });
    }
    if (String(req.params.id) === req.user.id) return res.status(409).json({ success: false, code: "SELF_ROLE_CHANGE_BLOCKED", message: "Users cannot change their own role." });
    try {
      const policy = await readActivePolicy(PolicyModel);
      const nextPermissions = policy.roles[roleKey];
      const currentActorPermissions = policy.roles[req.authz.roleKey] || [];
      if (!currentActorPermissions.includes("users.permissions.manage")) return res.status(403).json({ success: false, code: "PERMISSION_DENIED", message: "Your assigned role does not allow this action." });
      if (!nextPermissions) return res.status(400).json({ success: false, message: "The requested role is not configured." });
      if (nextPermissions.some(permission => !currentActorPermissions.includes(permission))) {
        return res.status(403).json({ success: false, code: "ROLE_ESCALATION_BLOCKED", message: "You cannot assign permissions beyond your own role." });
      }
      const query = UserModel.findById(req.params.id);
      const target = await readQuery(typeof query?.select === "function" ? query.select("roleKey active") : query);
      if (!target) return res.status(404).json({ success: false, message: "User not found." });
      const fromRole = target.roleKey || null;
      const audit = await AuditModel.create({ actorId: req.user.id, targetId: String(target._id), action: "user.role.assign", outcome: "pending", before: { role: fromRole }, after: { role: roleKey }, reason });
      const updated = await UserModel.updateOne(
        { _id: target._id, ...(fromRole ? { roleKey: fromRole } : { $or: [{ roleKey: null }, { roleKey: { $exists: false } }] }) },
        { $set: { roleKey }, $inc: { authzVersion: 1 } }
      );
      if (updated.matchedCount !== 1) {
        await AuditModel.updateOne({ _id: audit._id }, { $set: { outcome: "failed" } });
        return res.status(409).json({ success: false, message: "The user's role changed concurrently. Reload and retry." });
      }
      await AuditModel.updateOne({ _id: audit._id }, { $set: { outcome: "succeeded" } });
      return res.json({ success: true, data: { user: { id: String(target._id), role: roleKey } } });
    } catch {
      return res.status(503).json({ success: false, message: "The role change could not be completed and audited." });
    }
  });

  router.get("/policy", async (req, res) => {
    if (!req.authz?.permissions.includes("users.read")) return res.status(403).json({ success: false, code: "PERMISSION_DENIED", message: "Your assigned role does not allow this action." });
    try {
      const policy = await readActivePolicy(PolicyModel);
      return res.json({ success: true, data: { status: policy.status, revision: policy.revision || null, roles: policy.roles || {} } });
    } catch {
      return res.status(503).json({ success: false, message: "RBAC policy could not be loaded." });
    }
  });

  router.get("/audit", async (req, res) => {
    if (!req.authz?.permissions.includes("users.read")) return res.status(403).json({ success: false, code: "PERMISSION_DENIED", message: "Your assigned role does not allow this action." });
    try {
      const events = await AuditModel.find({}).sort({ createdAt: -1, _id: -1 }).limit(100).lean();
      return res.json({ success: true, data: { events: events.map(event => ({ id: String(event._id), actorId: event.actorId, targetId: event.targetId, action: event.action, outcome: event.outcome, before: event.before, after: event.after, reason: event.reason, createdAt: event.createdAt })) } });
    } catch {
      return res.status(503).json({ success: false, message: "RBAC audit history could not be loaded." });
    }
  });

  router.put("/policy", async (req, res) => {
    if (!req.authz?.permissions.includes("users.permissions.manage")) return res.status(403).json({ success: false, code: "PERMISSION_DENIED", message: "Your assigned role does not allow this action." });
    const roles = validateRoleMap(req.body?.roles);
    const revision = req.body?.revision;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!roles || !reason || reason.length > 500 ||
        (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) ||
        Object.keys(req.body || {}).some(key => !["roles", "reason", "revision"].includes(key))) {
      return res.status(400).json({ success: false, message: "A valid role-permission map and reason are required." });
    }
    try {
      const activePolicy = await readActivePolicy(PolicyModel);
      const actorPermissions = activePolicy.roles[req.authz.roleKey] || [];
      if (!actorPermissions.includes("users.permissions.manage")) return res.status(403).json({ success: false, code: "PERMISSION_DENIED", message: "Your assigned role does not allow this action." });
      if (!roles[req.authz.roleKey]?.includes("users.permissions.manage")) return res.status(409).json({ success: false, code: "ADMIN_LOCKOUT_BLOCKED", message: "The policy must retain permission administration for your assigned role." });
      if (Object.values(roles).some(permissions => permissions.some(permission => !actorPermissions.includes(permission)))) {
        return res.status(403).json({ success: false, code: "POLICY_ESCALATION_BLOCKED", message: "You cannot configure permissions beyond your own role." });
      }
      const current = await readQuery(PolicyModel.findOne({ key: "active" }));
      if (revision !== undefined && current?.revision !== revision) {
        return res.status(409).json({ success: false, message: "The RBAC policy has changed since it was opened. Reload and review the current policy." });
      }
      const audit = await AuditModel.create({ actorId: req.user.id, action: "rbac.policy.update", outcome: "pending", before: { revision: current?.revision || null, roles: current?.roles || null }, after: { roles }, reason });
      const update = await PolicyModel.findOneAndUpdate(
        { key: "active", revision: revision ?? current?.revision },
        { $set: { roles, updatedBy: req.user.id }, $inc: { revision: 1 }, $setOnInsert: { key: "active" } },
        { new: true, runValidators: true }
      );
      if (!update) {
        await AuditModel.updateOne({ _id: audit._id }, { $set: { outcome: "failed" } });
        return res.status(409).json({ success: false, message: "The RBAC policy changed concurrently. Reload and retry." });
      }
      await AuditModel.updateOne({ _id: audit._id }, { $set: { outcome: "succeeded", after: { revision: update.revision, roles } } });
      return res.json({ success: true, data: { revision: update.revision, roles } });
    } catch {
      return res.status(503).json({ success: false, message: "RBAC policy could not be changed and audited." });
    }
  });

  return router;
}

module.exports = createRbacRoutes;
