const crypto = require("node:crypto");

const { isMockCourierAdapterEnabled } = require("../utils/mockEnvironment");
const MOCK_ADAPTER_CODE = "MOCK_LOCAL";
const SAMPLE_AWB_PATTERN = /^SAMPLE-AWB-[a-f0-9]{32}$/;

function createTestReference(kind, value) {
  const digest = crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12).toUpperCase();
  return `LOCAL-${kind}-${digest}`;
}

function createMockCourierAdapter({ getEnvironment = () => process.env, getDatabaseName = () => null } = {}) {
  function assertEnabled() {
    const env = getEnvironment() || {};
    if (!isMockCourierAdapterEnabled({
      nodeEnv: env.NODE_ENV,
      deploymentMode: env.APP_DEPLOYMENT_MODE,
      enabled: env.MOCK_COURIER_ADAPTER_ENABLED,
      databaseName: getDatabaseName(),
    })) {
      const error = new Error("The local mock courier adapter is disabled outside its approved test environment.");
      error.code = "MOCK_COURIER_ADAPTER_DISABLED";
      throw error;
    }
  }

  return Object.freeze({
    code: MOCK_ADAPTER_CODE,
    name: "Local mock courier (no carrier request)",
    async quote(context = {}) {
      assertEnabled();
      const input = context.partnerInput || {};
      const mode = String(input.mode || "").trim().toUpperCase();
      const env = getEnvironment() || {};
      const rawSample = mode === "EXPRESS" ? env.MOCK_COURIER_EXPRESS_SAMPLE : env.MOCK_COURIER_SURFACE_SAMPLE;
      const sample = rawSample == null ? 1 : Number(rawSample);
      if (!Number.isFinite(sample) || sample <= 0) throw new Error("Configure a positive sample courier charge.");
      const testReference = createTestReference("QUOTE", context.draftId || "unknown-draft");
      return {
        serviceCode: "MOCK_LOCAL_PENDING_AWB",
        serviceName: "Local mock service (no carrier request)",
        mode,
        amount: sample,
        partnerTotal: sample,
        currency: "INR",
        provenance: "LOCAL_MOCK",
        serviceable: true,
        eta: "SIMULATED",
        estimateSnapshot: {
          source: "LOCAL_MOCK_ONLY",
          testReference,
          networkRequestMade: false,
          awbGenerated: false,
        },
      };
    },
    async book(context = {}) {
      assertEnabled();
      const data = context.draftSnapshot || {};
      const reference = data.formData?.reference || data.reference || context.selectedQuote?.id || "unknown-draft";
      const testReference = createTestReference("BOOKING", reference);
      if (getEnvironment()?.MOCK_COURIER_SAMPLE_AWB_ENABLED === "true") {
        const waybill = "SAMPLE-AWB-" + crypto.randomUUID().replaceAll("-", "");
        return {
          waybill,
          receipt: { success: true, source: "LOCAL_MOCK_ONLY", sampleWaybill: waybill, testReference, waybillGenerated: false },
          record: { providerCode: MOCK_ADAPTER_CODE, mockOnly: true, sampleWaybill: waybill, mockTestReference: testReference, networkRequestMade: false, awbGenerated: false },
        };
      }
      return {
        bookingStatus: "BOOKED_AWB_PENDING",
        receipt: {
          success: true,
          status: "BOOKED_AWB_PENDING",
          source: "LOCAL_MOCK_ONLY",
          testReference,
          waybillGenerated: false,
        },
        record: {
          providerCode: MOCK_ADAPTER_CODE,
          mockOnly: true,
          mockTestReference: testReference,
          networkRequestMade: false,
          awbGenerated: false,
          waybill: "",
        },
      };
    },
    async track({ waybill, shipmentSnapshot } = {}) {
      assertEnabled();
      if (getEnvironment()?.MOCK_COURIER_SAMPLE_AWB_ENABLED !== "true" || !SAMPLE_AWB_PATTERN.test(waybill || "") ||
        shipmentSnapshot?.record?.mockOnly !== true || shipmentSnapshot.record.sampleWaybill !== waybill) {
        throw new Error("Sample tracking is unavailable for this shipment.");
      }
      return { events: [{
        status: "Sample pickup pending", occurredAt: new Date(shipmentSnapshot.createdAt).toISOString(),
        providerEventId: waybill + "-PICKUP-PENDING", description: "Demo scan. No carrier status was requested.",
      }] };
    },
  });
}

module.exports = { MOCK_ADAPTER_CODE, SAMPLE_AWB_PATTERN, isMockCourierAdapterEnabled, createTestReference, createMockCourierAdapter };
