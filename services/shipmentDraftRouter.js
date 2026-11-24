const express = require("express");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const requireSession = require("../utils/requireSession");
const { resolveCustomerCard, buildPricingSnapshot } = require("./customerPricingService");
const { findRegisteredWarehouse, snapshotFromWarehouse, applyWarehouseToForm } = require("./warehouseValidation");
const { parseDateRange } = require("../controller/dashboardController");

const FORM_FIELDS = new Set([
  "warehouse", "warehouseId", "warehouseAddress", "warehousePincode", "warehouseContact", "warehousePhone", "reference", "state", "description", "quantity", "customer", "consigneeCompanyName", "consigneeGstin",
  "bookingCustomerId", "shipperCompanyName", "shipperContactName", "shipperPhone", "shipperEmail", "shipperAddress",
  "shipperCity", "shipperState", "shipperPincode", "shipperGstin", "pickupChoice", "pickupContactName", "pickupPhone",
  "pickupEmail", "pickupAddress", "pickupCity", "pickupState", "pickupPincode", "email", "phone", "address", "pincode",
  "destination", "weight", "boxes", "actualWeightKg", "volumetricWeightKg", "chargeableWeightKg", "length", "width", "height",
  "value", "payment", "mode", "pincodeServiceable", "pincodeServiceability", "productSearch", "destinationZone", "shipperAddressId", "consigneeAddressId", "pickupAddressId",
  "productCategory", "handlingInstructions", "fragile",
  // Derived warehouse/serviceability fields are accepted for compatibility
  // with deployed clients; canonical values are still taken from the
  // owner-scoped warehouse record below.
  "warehouseDetails", "registeredWarehouse", "warehouseRegistrationStatus", "serviceability",
]);
const ADDRESS_TYPES = { shipperAddressId: "SHIPPER", consigneeAddressId: "CONSIGNEE", pickupAddressId: "PICKUP" };

class DraftInputError extends Error { constructor(message, code) { super(message); this.code = code; } }
const isObject = value => value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function serialize(row) {
  return {
    id: String(row._id), reference: row.reference, state: row.state, bookingAttempt: row.draftData?.bookingAttempt || null, formData: row.draftData?.formData || {},
    customerSnapshot: row.draftData?.customerSnapshot || null,
    rateCardSnapshot: row.draftData?.rateCardSnapshot || null,
    pricingSnapshot: row.draftData?.pricingSnapshot || null,
    pricingSnapshotHistory: row.draftData?.pricingSnapshotHistory || [],
    partnerQuoteBatches: row.draftData?.partnerQuoteBatches || [],
    selectedPartnerQuote: row.draftData?.selectedPartnerQuote || null,
    shipperSnapshot: row.draftData?.shipperSnapshot || null,
    consigneeSnapshot: row.draftData?.consigneeSnapshot || null,
    pickupSnapshot: row.draftData?.pickupSnapshot || null,
    warehouseSnapshot: row.draftData?.warehouseSnapshot || null,
    destinationSnapshot: row.draftData?.destinationSnapshot || null,
    packageRows: row.draftData?.packageRows || [],
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

module.exports = function shipmentDraftRouter({ Shipment, Customer, PartyAddress, RateCard, Warehouse }) {
  const router = express.Router();
  router.use("/shipments/drafts", requireSession);

  async function prepare(req) {
    if (!isObject(req.body) || !isObject(req.body.formData)) throw new DraftInputError("formData must be an object.");
    let form = req.body.formData;
    const unsupported = Object.keys(form).filter(key => !FORM_FIELDS.has(key));
    if (unsupported.length) throw new DraftInputError(`formData contains unsupported fields: ${unsupported.join(", ")}.`);
    if (Buffer.byteLength(JSON.stringify(form), "utf8") > 65536) throw new DraftInputError("Draft formData exceeds 64 KB.");
    form = { ...form };
    // These values are display metadata from newer clients. Never trust them
    // for authorization or registration; the canonical warehouse is resolved
    // by warehouseId and the serviceability snapshot is only informational.
    delete form.warehouseDetails;
    delete form.registeredWarehouse;
    delete form.warehouseRegistrationStatus;
    delete form.serviceability;
    // Serviceability is a frontend display snapshot only. It must never be
    // treated as carrier proof; booking performs a fresh server-side check.
    delete form.pincodeServiceability;
    delete form.pincodeServiceable;
    for (const [field, maxLength] of Object.entries({ productCategory: 120, handlingInstructions: 500 })) {
      if (!Object.hasOwn(form, field)) continue;
      if (typeof form[field] !== "string" || form[field].trim().length > maxLength) {
        throw new DraftInputError(`${field} must be text up to ${maxLength} characters.`);
      }
      form[field] = form[field].trim();
    }
    if (Object.hasOwn(form, "fragile") && typeof form.fragile !== "boolean") throw new DraftInputError("fragile must be a boolean.");
    if (form.boxes !== undefined && (!Array.isArray(form.boxes) || form.boxes.length < 1 || form.boxes.length > 5 || form.boxes.some(box => !isObject(box)))) {
      throw new DraftInputError("boxes must contain between 1 and 5 package rows.");
    }
    for (const key of ["bookingCustomerId", ...Object.keys(ADDRESS_TYPES), "warehouseId"]) {
      if (form[key] && (typeof form[key] !== "string" || !mongoose.isValidObjectId(form[key]))) throw new DraftInputError(`${key} must be a valid MongoDB ObjectId.`);
    }
    if (!form.warehouseId) throw new DraftInputError("Select a MongoDB warehouse before saving this draft.", "WAREHOUSE_INVALID");
    const registeredWarehouse = await findRegisteredWarehouse(Warehouse, req.user.id, form.warehouseId);
    if (!registeredWarehouse) throw new DraftInputError("Selected warehouse is not registered for this account.", "WAREHOUSE_INVALID");
    const warehouseSnapshot = snapshotFromWarehouse(registeredWarehouse);
    form = applyWarehouseToForm(form, warehouseSnapshot);

    let customerSnapshot = null;
    let rateCardSnapshot = null;
    if (form.bookingCustomerId) {
      const customer = await Customer.findOne({ _id: form.bookingCustomerId, owner: req.user.id }).lean();
      if (!customer) throw new DraftInputError("Selected customer was not found for this account.");
      const { _id, owner, __v, createdAt, updatedAt, ...customerData } = customer;
      customerSnapshot = { id: String(_id), ...customerData };
      const card = customer.rateCardId ? await RateCard.findOne({ _id: customer.rateCardId, owner: req.user.id }).lean() : null;
      const compatible = resolveCustomerCard(customer, card ? [card] : []);
      if (customer.rateCardId && !compatible) throw new DraftInputError("Customer rate-card assignment is invalid for this account or customer category.");
      if (compatible) rateCardSnapshot = { id: String(compatible._id), scope: compatible.scope, customerId: compatible.customerId ? String(compatible.customerId) : null, name: compatible.name || "", version: compatible.version };
    }

    const snapshots = {};
    for (const [field, partyType] of Object.entries(ADDRESS_TYPES)) {
      if (!form[field]) { snapshots[field] = null; continue; }
      const address = await PartyAddress.findOne({ _id: form[field], owner: req.user.id, partyType }).lean();
      if (!address) throw new DraftInputError(`Selected ${partyType.toLowerCase()} address was not found for this account.`);
      if (address.customerId && String(address.customerId) !== String(form.bookingCustomerId || "")) throw new DraftInputError(`Selected ${partyType.toLowerCase()} address belongs to another customer.`);
      const { _id, owner, createdAt, updatedAt, __v, ...snapshot } = address;
      snapshots[field] = { id: String(_id), ...snapshot };
    }
    const manualParty = (prefix, idKey) => {
      const entered = {
        companyName: form[`${prefix}CompanyName`] || "",
        contactName: form[`${prefix}ContactName`] || "",
        phone: form[`${prefix}Phone`] || "",
        email: form[`${prefix}Email`] || "",
        addressLines: String(form[`${prefix}Address`] || "").split(/\r?\n|,/).map(value => value.trim()).filter(Boolean),
        city: form[`${prefix}City`] || "", state: form[`${prefix}State`] || "", pincode: form[`${prefix}Pincode`] || "",
        ...(prefix === "shipper" ? { gstin: form.shipperGstin || "" } : prefix === "consignee" ? { gstin: form.consigneeGstin || "" } : {}),
      };
      return snapshots[idKey] ? { ...snapshots[idKey], ...entered, id: snapshots[idKey].id } : entered;
    };    const shipperSnapshot = manualParty("shipper", "shipperAddressId");
    const consigneeSnapshot = manualParty("consignee", "consigneeAddressId");
    let pickupSnapshot = snapshots.pickupAddressId || (form.pickupChoice === "sameAsShipper" ? { ...shipperSnapshot } : manualParty("pickup", "pickupAddressId"));
    pickupSnapshot = { choice: form.pickupChoice || "warehouse", warehouseName: form.warehouse || "", ...pickupSnapshot };
    const destinationSnapshot = { pincode: form.pincode || "", city: form.destination || "", state: form.state || "", zone: form.destinationZone || "" };
    const rateCard = form.bookingCustomerId && customerSnapshot?.rateCardId
      ? await RateCard.findOne({ _id: customerSnapshot.rateCardId, owner: req.user.id }).lean()
      : null;
    const pricingSnapshot = buildPricingSnapshot(rateCard && resolveCustomerCard({ ...customerSnapshot, _id: customerSnapshot.id }, [rateCard]), {
      zone: destinationSnapshot.zone,
      chargeableWeight: Number(form.chargeableWeightKg),
      paymentType: form.payment === "COD" ? "COD" : "PREPAID",
      codAmount: form.payment === "COD" ? Number(form.value || 0) : 0,
    });
    return { formData: form, customerSnapshot, rateCardSnapshot, pricingSnapshot, shipperSnapshot, consigneeSnapshot, pickupSnapshot, warehouseSnapshot, destinationSnapshot, packageRows: form.boxes || [] };
  }

  router.get("/shipments/drafts", async (req, res) => {
    const rawPage = req.query.page ?? "1";
    if (typeof rawPage !== "string" || !/^[1-9]\d{0,5}$/.test(rawPage)) {
      return res.status(400).json({ success: false, message: "Invalid pending AWB page." });
    }
    let from, to;
    try { ({ from, to } = parseDateRange(req.query)); }
    catch (error) { return res.status(400).json({ success: false, message: error.message }); }
    const page = Number(rawPage);
    const pageSize = 100;
    try {
      const createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) };
      const rows = await Shipment.find({ owner: req.user.id, ...(from || to ? { createdAt } : {}), $or: [
        { kind: "forward", state: { $in: ["draft", "creating"] } },
        { kind: { $in: ["forward", null] }, state: "saved", "record.bookingStatus": "BOOKED_AWB_PENDING", waybill: { $in: [null, ""] }, "record.waybill": { $in: [null, ""] } },
      ] }).sort({ updatedAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize + 1).lean();
      return res.json({ success: true, data: {
        drafts: rows.slice(0, pageSize).map(serialize), page, hasMore: rows.length > pageSize,
      } });
    } catch { return res.status(503).json({ success: false, message: "Drafts could not be loaded." }); }
  });

  router.post("/shipments/drafts", async (req, res) => {
    try {
      const draftData = await prepare(req);
      const row = await Shipment.create({ owner: req.user.id, reference: `DRAFT-${crypto.randomUUID()}`, state: "draft", kind: "forward", draftData });
      return res.status(201).json({ success: true, data: { draft: serialize(row) } });
    } catch (error) {
      if (error instanceof DraftInputError) return res.status(400).json({ success: false, ...(error.code ? { code: error.code } : {}), message: error.message });
      return res.status(503).json({ success: false, message: "Draft could not be saved." });
    }
  });

  router.get("/shipments/drafts/:id", async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid draft ID." });
    try {
      const row = await Shipment.findOne({ _id: req.params.id, owner: req.user.id, state: { $in: ["draft", "creating"] }, kind: "forward" }).lean();
      return row ? res.json({ success: true, data: { draft: serialize(row) } }) : res.status(404).json({ success: false, message: "Draft or booking attempt not found." });
    } catch { return res.status(503).json({ success: false, message: "Draft could not be loaded." }); }
  });

  router.patch("/shipments/drafts/:id", async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid draft ID." });
    try {
      const existing = await Shipment.findOne({ _id: req.params.id, owner: req.user.id, state: "draft", kind: "forward" }).lean();
      if (!existing) return res.status(404).json({ success: false, message: "Draft not found." });
      const draftData = await prepare(req);
      const previous = existing.draftData || {};
      const pricingSnapshotHistory = [...(previous.pricingSnapshotHistory || [])];
      if (previous.pricingSnapshot && JSON.stringify(previous.pricingSnapshot) !== JSON.stringify(draftData.pricingSnapshot)) {
        pricingSnapshotHistory.push({ capturedAt: new Date().toISOString(), rateCardSnapshot: previous.rateCardSnapshot || null, pricingSnapshot: previous.pricingSnapshot });
      }
      const quoteBatches = (previous.partnerQuoteBatches || []).map(batch => ({ ...batch, archived: true }));
      Object.assign(draftData, {
        pricingSnapshotHistory,
        partnerQuoteBatches: quoteBatches,
        activePartnerQuoteBatchId: null,
        selectedPartnerQuote: null,
      });
      const row = await Shipment.findOneAndUpdate(
        { _id: req.params.id, owner: req.user.id, state: "draft", kind: "forward", updatedAt: existing.updatedAt },
        { $set: { draftData } }, { new: true, runValidators: true }
      ).lean();
      return row ? res.json({ success: true, data: { draft: serialize(row) } }) : res.status(404).json({ success: false, message: "Draft not found." });
    } catch (error) {
      if (error instanceof DraftInputError) return res.status(400).json({ success: false, ...(error.code ? { code: error.code } : {}), message: error.message });
      return res.status(503).json({ success: false, message: "Draft could not be updated." });
    }
  });
  return router;
};






