const express = require("express");
const requireSession = require("../utils/requireSession");
const { shipmentGroup, shipmentDashboardTags } = require("./dashboardService");
const { createDelhiveryCourierAdapter, classifyBookingResponse } = require("./delhiveryCourierAdapter");
const { safeProviderSnapshot } = require("../utils/delhiveryError");
const { findRegisteredWarehouse, snapshotFromWarehouse } = require("./warehouseValidation");
const { isDelhiveryFeatureEnabled, delhiveryFeatureDisabledResponse } = require("../utils/delhiveryFeatureFlags");
const { buildPricingSnapshot, resolveCustomerCard } = require("./customerPricingService");
const { validateQuote, partnerCostSnapshots } = require("./courierQuotationService");
const mongoose = require("mongoose");

function rejectionReason(data, parcel) {
  const messages = [
    parcel?.remarks,
    data?.rmk,
    data?.message,
    data?.error,
    data?.errors,
  ]
    .flat()
    .filter(value =>
      typeof value === "string" && value.trim() && value !== "false"
    )
    .map(value => value.trim());

  return [...new Set(messages)].join(" ");
}

function normalize(input, warehouse, waybill, createdAt) {
  return {
    id: String(waybill),
    reference: input.order,
    customer: input.name || "",
    address: input.add || "",
    destination: input.city || "",
    state: input.state || "",
    pincode: String(input.pin || ""),
    phone: String(input.phone || ""),
    email: input.email || "",
    payment: input.payment_mode || "",
    value: Number(input.total_amount) || 0,
    weight: (Number(input.weight) || 0) / 1000,
    dimensions: [
      input.shipment_length,
      input.shipment_width,
      input.shipment_height,
    ].join(" × "),
    warehouse: warehouse || "",
    ewaybill: "",
    date: new Date(createdAt).toISOString().slice(0, 10),
    status: "Pending pickup",
    history: [],
    providerCode: "DELHIVERY",
    providerOutcome: "PROVIDER_CONFIRMED",
  };
}

module.exports = function appShipmentRouter({ Shipment, Warehouse, Customer, RateCard, carrier, statusMappings = {}, getEnvironment = () => process.env }) {
  const router = express.Router();
  const getDelhiveryAdapter = () => createDelhiveryCourierAdapter(carrier, { getEnvironment });

  // MongoDB-only lookup for an existing forward shipment.
  router.get("/shipments/lookup", requireSession, async (req, res) => {
    const waybill = String(req.query.waybill || "").trim();
    if (!waybill || waybill.length > 80) {
      return res.status(400).json({ success: false, message: "Enter a valid waybill." });
    }
    try {
      const shipment = await Shipment.findOne({
        owner: req.user.id,
        state: "saved",
        waybill,
        $or: [{ kind: "forward" }, { kind: { $exists: false } }],
      }).select("waybill reference record").lean();
      if (!shipment || !shipment.record) {
        return res.status(404).json({ success: false, message: "No saved forward shipment found for this waybill in your account." });
      }
      return res.json({
        success: true,
        data: { shipment: { ...shipment.record, waybill: shipment.waybill, reference: shipment.record.reference || shipment.reference } },
      });
    } catch (error) {
      return res.status(503).json({ success: false, message: "Could not fetch the saved shipment from MongoDB." });
    }
  });


  const forwardShipmentFilter = {
    $or: [
      { kind: "forward" },
      { kind: { $exists: false } },
    ],
  };

  router.get("/shipments", requireSession, async (req, res) => {
    const page = req.query.page ?? "1";
    const limit = req.query.limit ?? "100";

    if (
      typeof page !== "string" ||
      !/^[1-9]\d*$/.test(page) ||
      typeof limit !== "string" ||
      !/^[1-9]\d*$/.test(limit) ||
      Number(limit) > 100 ||
      !Number.isSafeInteger(Number(page) * Number(limit))
    ) {
      return res.status(400).json({
        success: false,
        message: "page must be a positive integer; limit must be between 1 and 100.",
      });
    }

    try {
      const filter = {
        owner: req.user.id,
        state: "saved",
        ...forwardShipmentFilter,
      };

      const total = await Shipment.countDocuments(filter);

      const rows = await Shipment.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .lean();

      return res.json({
        success: true,
        data: {
          // Return only the canonical dashboard group alongside the existing
          // account record. Provider codes, raw tracking events and mappings
          // remain private to the backend.
          shipments: rows.map(row => row.record
            ? { ...row.record, dashboardStatus: shipmentGroup(row, statusMappings), dashboardTags: shipmentDashboardTags(row, statusMappings) }
            : row.record),
          total,
          page: Number(page),
          limit: Number(limit),
          source: "app-created",
        },
      });
    } catch {
      return res.status(503).json({
        success: false,
        message: "Saved shipments could not be loaded. Check the backend database connection and retry.",
      });
    }
  });

  router.post("/shipments", requireSession, async (req, res) => {
    const submitted = req.body?.shipments?.[0];

    if (
      !Array.isArray(req.body?.shipments) ||
      req.body.shipments.length !== 1 ||
      typeof submitted?.order !== "string" ||
      !submitted.order.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Submit one shipment with a unique order reference.",
      });
    }

    // This legacy endpoint calls Delhivery directly, outside the adapter
    // registry. Require an explicit opt-in before reserving or contacting it.
    if (!isDelhiveryFeatureEnabled("SHIPMENT_BOOKING", getEnvironment())) return delhiveryFeatureDisabledResponse(res, "SHIPMENT_BOOKING");
    const input = { ...submitted, order: submitted.order.trim() };

    let intent;
    let providerPayload;
    let registeredWarehouse;
    let bookingPricing;

    try {
      await Shipment.init();

      const previous = await Shipment.findOne({
        owner: req.user.id,
        reference: input.order,
      });

      if (previous) {
        if (previous.state === "saved" && previous.kind !== "reverse") {
          return res.json({
            success: true,
            data: previous.receipt,
            shipment: previous.record,
          });
        }

        return res.status(409).json({
          success: false,
          message: "This order reference is already reserved or belongs to another shipment type. Check it before retrying.",
        });
      }

      const warehouseId = req.body?.pickup_location?.warehouseId;
      try {
        registeredWarehouse = await findRegisteredWarehouse(Warehouse, req.user.id, warehouseId);
      } catch {
        return res.status(503).json({ success: false, code: "WAREHOUSE_LOOKUP_FAILED", message: "Warehouse registration could not be verified. No booking request was sent." });
      }
      if (!registeredWarehouse) {
        return res.status(400).json({ success: false, code: "WAREHOUSE_INVALID", message: "Select a registered warehouse belonging to this account before booking." });
      }
      if (!/^\d{6}$/.test(String(input.pin || "")) || !/^(COD|PRE-?PAID)$/i.test(String(input.payment_mode || ""))) {
        return res.status(400).json({ success: false, message: "Provide a valid destination pincode and payment mode." });
      }
      const { customerId, zone, chargeableWeight } = req.body.pricingInput || {};
      const mode = String(input.shipping_mode || "").trim().toUpperCase();
      const actualWeight = Number(input.weight) / 1000;
      const paymentType = String(input.payment_mode).toUpperCase() === "COD" ? "COD" : "PREPAID";
      const codAmount = paymentType === "COD" ? Number(input.cod_amount) : 0;
      if (!Customer || !RateCard || !mongoose.isValidObjectId(customerId) ||
        typeof zone !== "string" || !zone.trim() || zone.length > 100 || !Number.isFinite(chargeableWeight) ||
        !Number.isFinite(actualWeight) || actualWeight <= 0 || chargeableWeight < actualWeight ||
        !["SURFACE", "EXPRESS"].includes(mode) || (paymentType === "COD" && (!Number.isFinite(codAmount) || codAmount <= 0))) {
        return res.status(400).json({ success: false, code: "BOOKING_PRICING_INPUT_INVALID", message: "Provide a customer, zone, shipping mode, valid shipment weights and the collection amount for COD." });
      }
      const customer = await Customer.findOne({ _id: customerId, owner: req.user.id }).lean();
      if (!customer) return res.status(404).json({ success: false, code: "BOOKING_CUSTOMER_INVALID", message: "Customer not found." });
      const rate = customer.rateCardId && await RateCard.findOne({ _id: customer.rateCardId, owner: req.user.id }).lean();
      const card = resolveCustomerCard(customer, rate ? [rate] : []);
      const snapshot = buildPricingSnapshot(card, { zone: zone.trim(), chargeableWeight, paymentType, codAmount });
      if (snapshot.customerSelling?.[mode]?.status !== "READY") {
        return res.status(409).json({ success: false, code: "BOOKING_PRICING_CONFIGURATION_REQUIRED", message: "Direct booking requires an approved selling price for the selected customer and mode." });
      }
      const { _id, owner, __v, createdAt, updatedAt, ...customerData } = customer;
      bookingPricing = { customerSnapshot: { id: String(_id), ...customerData }, rateCardSnapshot: snapshot.card,
        rateCardConfigurationSnapshot: snapshot.rateCardConfiguration, customerSellingPriceSnapshot: snapshot,
        customerTaxBasisSnapshot: snapshot.taxBasis || null, warehouseSnapshot: snapshotFromWarehouse(registeredWarehouse), mode };
      const { pricingInput, ...providerBody } = req.body;
      providerPayload = {
        ...providerBody,
        shipments: [input],
        pickup_location: { name: registeredWarehouse.name },
      };
      let serviceable;
      try {
        serviceable = await getDelhiveryAdapter().checkServiceability({ pincode: input.pin, paymentType: input.payment_mode });
      } catch {
        return res.status(503).json({ success: false, code: "BOOKING_SERVICEABILITY_UNAVAILABLE", message: "Courier serviceability could not be verified. No booking request was sent." });
      }
      if (!serviceable) return res.status(409).json({ success: false, code: "QUOTE_NOT_SERVICEABLE", message: "The courier has not confirmed serviceability for this shipment." });
      let partnerQuote = null;
      if (isDelhiveryFeatureEnabled("SHIPPING_COST", getEnvironment()) && /^\d{6}$/.test(bookingPricing.warehouseSnapshot?.pincode || "")) {
        try {
          const adapter = getDelhiveryAdapter();
          partnerQuote = validateQuote(adapter, await adapter.quote({ partnerInput: {
            originPincode: bookingPricing.warehouseSnapshot.pincode,
            destinationPincode: String(input.pin), chargeableWeightKg: chargeableWeight, mode, paymentType, codAmount,
          } }));
        } catch { /* Keep the carrier estimate unavailable and retain the independently calculated selling price. */ }
      }
      Object.assign(bookingPricing, partnerCostSnapshots(partnerQuote));

      intent = await Shipment.create({
        owner: req.user.id,
        reference: input.order,
        state: "creating",
        kind: "forward",
        record: bookingPricing,
      });
    } catch (error) {
      return res.status(error.code === 11000 ? 409 : 503).json({
        success: false,
        message: "The order could not be reserved. It may already be processing, or the database is unavailable. No new carrier request was sent.",
      });
    }

    let data;

    try {
      const response = await carrier.post(
        "/api/cmu/create.json",
        `format=json&data=${encodeURIComponent(JSON.stringify(providerPayload))}`,
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      data = response.data;
    } catch {
      return res.status(502).json({
        success: false,
        message: "Delhivery did not confirm creation. This order may have been created. Check it in Delhivery before retrying.",
      });
    }

    const parcel = data?.packages?.[0];
    const { waybill, outcome } = classifyBookingResponse(data, parcel);

    if (outcome !== "CONFIRMED") {
      const uncertain = outcome === "AMBIGUOUS";
      if (!uncertain) {
        try {
          await Shipment.deleteOne({
            _id: intent._id,
            owner: req.user.id,
            state: "creating",
          });
        } catch {
          // Retain reservation when its removal cannot be confirmed.
        }
      }

      const safeData = safeProviderSnapshot(data);
      const reason = rejectionReason(safeData, safeData?.packages?.[0]);
      const insufficientBalance = /insufficient\s+balance/i.test(reason);
      const uncertainSaveWarning =
        "The package might have been partially saved. Verify the original order/reference with Delhivery before retrying. Do not submit it with a new reference until you confirm the original request was not saved.";

      const message = insufficientBalance
        ? "Delhivery reported insufficient balance in the prepaid carrier account. Recharge the account or contact your account administrator. " +
          (uncertain
            ? uncertainSaveWarning
            : "Check the order in Delhivery before retrying.")
        : "Delhivery did not confirm an accepted shipment. " +
          (reason ? `Reason: ${reason} ` : "") +
          (uncertain
            ? uncertainSaveWarning
            : "Check the order before retrying.");

      return res.status(502).json({
        success: false,
        message,
        data: safeData,
      });
    }

    const record = normalize(
      input,
      registeredWarehouse.name,
      waybill,
      intent.createdAt
    );
    Object.assign(record, bookingPricing);

    const receipt = {
      success: true,
      packages: [
        { waybill: String(waybill), status: "Success" },
      ],
    };

    try {
      const savedResult = await Shipment.updateOne(
        {
          _id: intent._id,
          owner: req.user.id,
          state: "creating",
          kind: "forward",
        },
        {
          $set: {
            state: "saved",
            kind: "forward",
            waybill: String(waybill),
            record,
            receipt,
          },
        }
      );

      if (savedResult.matchedCount !== 1) {
        return res.status(503).json({
          success: false,
          code: "SHIPMENT_SAVE_FAILED",
          waybill: String(waybill),
          message: `Delhivery created waybill ${waybill}, but the reserved database record could not be confirmed. Do not submit it again.`,
        });
      }
    } catch {
      return res.status(503).json({
        success: false,
        code: "SHIPMENT_SAVE_FAILED",
        waybill: String(waybill),
        message: `Delhivery created waybill ${waybill}, but saving it failed. Do not create it again. Contact support with this waybill and order reference.`,
      });
    }

    return res.status(201).json({
      success: true,
      data: receipt,
      shipment: record,
    });
  });

  for (const action of ["update", "cancel", "ewaybill"]) {
    router.post(`/shipments/${action}`, requireSession, async (req, res) => {
      const actionFeature = action === "cancel" ? "SHIPMENT_CANCELLATION" : action === "ewaybill" ? "EWAYBILL" : "SHIPMENT_UPDATE";
      if (!isDelhiveryFeatureEnabled(actionFeature, getEnvironment())) return delhiveryFeatureDisabledResponse(res, actionFeature);
      const waybill = req.body?.waybill;

      if (typeof waybill !== "string" || !waybill) {
        return res.status(400).json({
          success: false,
          message: "Waybill is required.",
        });
      }

      try {
        const saved = await Shipment.findOne({
          owner: req.user.id,
          waybill,
          state: "saved",
          ...forwardShipmentFilter,
        });

        if (!saved) {
          return res.status(404).json({
            success: false,
            message: "Forward shipment not found for your login.",
          });
        }

        const adapter = getDelhiveryAdapter();

        const body = { waybill };
        const allowed =
          action === "ewaybill"
            ? ["ewbn"]
            : ["name", "add", "phone", "pin", "city"];

        for (const key of allowed) {
          if (req.body[key] !== undefined) {
            body[key] = req.body[key];
          }
        }

        let result;
        try {
          result = action === "cancel"
            ? await adapter.cancelShipment({ waybill })
            : action === "ewaybill"
              ? await adapter.updateEwaybill({ waybill, ewbn: body.ewbn })
              : await adapter.updateShipment(body);
        } catch (error) {
          if (error?.definitive === true || error?.outcome === "REJECTED") {
            return res.status(502).json({ success: false, message: "Delhivery rejected the update.", data: safeProviderSnapshot(error.responseSnapshot) });
          }
          return res.status(503).json({ success: false, message: "Shipment action could not be confirmed. Check its status before retrying." });
        }
        const data = result.responseSnapshot;

        const changes = {};

        if (action === "cancel") {
          changes["record.status"] = "Cancelled";
        }

        for (const [key, field] of Object.entries({
          name: "customer",
          add: "address",
          phone: "phone",
          pin: "pincode",
          city: "destination",
          ewbn: "ewaybill",
        })) {
          if (body[key] !== undefined) {
            changes[`record.${field}`] = body[key];
          }
        }

        const updateResult = await Shipment.updateOne(
          {
            _id: saved._id,
            owner: req.user.id,
            state: "saved",
            ...forwardShipmentFilter,
          },
          { $set: changes }
        );

        if (updateResult.matchedCount !== 1) {
          return res.status(503).json({
            success: false,
            message: "Delhivery accepted the change, but the local shipment update could not be confirmed. Check the shipment before retrying.",
          });
        }

        return res.json({ success: true, data: safeProviderSnapshot(data) });
      } catch {
        return res.status(503).json({
          success: false,
          message: "Shipment action could not be confirmed. Check its status before retrying.",
        });
      }
    });
  }

  return router;
};
