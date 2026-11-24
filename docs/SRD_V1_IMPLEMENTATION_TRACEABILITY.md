# Courier Management Software SRD v1.0 — Implementation Traceability

**Assessment date:** 2026-11-16  
**Scope:** SRD sections 3–18, current source in `D:\delhivery` and `D:\delhivery-backebnd`, automated tests, and phase documentation.  
**Method:** Read-only source/test inspection and safe local test suites. No database or provider calls were made. The requirement column expresses the individual acceptance criteria in traceable form; it is a concise paraphrase, not a reproduction of the SRD text.

## Executive summary

The repository now contains substantial implementation across booking, customer/rate-card management, operational workflows, finance, search, audit/logging, and local mock testing. The current status is **local workflow acceptance in progress; not production/provider acceptance**. The mock courier is the only active booking/quotation adapter in the verified local configuration. Delhivery live integration is disabled. Automated adapter tests use injected mocks and do not prove carrier account readiness, provider-side behavior, or production operations.

| Area | Assessment |
|---|---|
| Phase 1 Core Booking | **PARTIALLY IMPLEMENTED.** Draft/quote/mock booking and owner-scoped customer/rate-card/address masters exist. Legacy direct booking remains as a separate, guarded path. Full provider selection, approved tariff rules, final AWB handling, and manual acceptance remain. |
| Phase 2 Operations | **PARTIALLY IMPLEMENTED.** Local pickup, tracking histories, NDR/RTO workflows, dashboard metrics, and owner-scoped lists exist. Provider-confirmed pickup/tracking/exception behavior and verified Out for Delivery mapping remain unaccepted or unavailable. |
| Phase 3 Finance | **PARTIALLY IMPLEMENTED.** Billing, invoices, payments, partner costs, profitability report and CSV/XLSX/PDF exports exist. Tax/surcharge inputs and some final-cost facts remain configuration/client/provider dependent. |
| Phase 4 Advanced | **PARTIALLY IMPLEMENTED.** RBAC code is present but intentionally disabled pending approval; audit, structured logs, search, retry safeguards, and backup/restore documentation exist to differing degrees. Automated infrastructure backup and restore are not available in this repository. |
| Security / ownership | Authenticated routes and owner filters are broadly tested. RBAC is not active; manual role acceptance and deployment security review are outstanding. |
| Historical preservation | Shipment-time customer/rate/pricing/partner quote snapshots and append-only operational histories are used. Retention policy, backup evidence, and historical migrations still need operational acceptance. |
| Dashboard consistency | NDR/RTO count unique shipments and the detail flows support related cases/events; Pending AWB, Delivered, In Transit and Active RTO fixes have tests. OOD remains unsupported pending verified mapping. |
| Provider verification | **No live courier verification in this assessment.** Real Delhivery adapter tests inject mocked clients; local mock explicitly makes no network calls and does not generate real AWBs. |

There are two shipment booking paths: legacy `POST /api/delhivery/shipments` directly invokes the Delhivery service when its server flag is explicitly enabled; the new `/api/shipments/drafts/...` workflow saves drafts, requests registry quotes, selects a quote, books through that adapter, and reconciles ambiguous outcomes. They are intentionally retained side by side. The frontend hides/disables the legacy action unless authenticated backend readiness is `true`. This duplication is a maintenance and acceptance risk; it is not evidence that the two flows have equivalent validation or provider behavior.

### Status definitions

- **IMPLEMENTED:** Source behavior is present and has relevant automated coverage or clear source evidence. It is not, by itself, live-provider or manual acceptance.
- **PARTIALLY IMPLEMENTED:** Some required behavior exists, but identifiable criteria, workflows, status mappings, or acceptance evidence are missing.
- **NOT IMPLEMENTED:** No implementation was found for the criterion.
- **CLIENT DECISION REQUIRED:** The feature cannot be completed correctly without an unprovided business rule or approval.
- **EXTERNAL DEPENDENCY:** Completion requires provider, infrastructure, credential, or operational evidence not in source control.

## Requirement-by-requirement traceability matrix

`Mock/local` in the evidence column means tests use fake/in-memory repositories, mocked provider adapters, or the explicitly local mock adapter. **No row below has live provider confirmation from automated tests.** Files are linked relative to this document where practical.

### §3 Shipment booking — six workflow sections

| SRD ref | Individual requirement / acceptance criterion | Status | Frontend / backend implementation | Automated evidence and scope | Remaining work / evidence to complete |
|---|---|---|---|---|---|
| 3.1 Destination | Collect destination pincode and required city/state/address; resolve available destination data and serviceability. | PARTIALLY IMPLEMENTED | [`DeliveryDestinationStep.jsx`](../../delhivery/src/components/shipments/steps/DeliveryDestinationStep.jsx), [`RecipientDetailsStep.jsx`](../../delhivery/src/components/shipments/steps/RecipientDetailsStep.jsx), [`CreateShipmentPage.jsx`](../../delhivery/src/pages/shipments/CreateShipmentPage.jsx); backend [`checkPincodeController.js`](../controller/checkPincodeController.js), [`appShipmentRouter.js`](../services/appShipmentRouter.js), quote preflight in [`shipmentQuoteRouter.js`](../services/shipmentQuoteRouter.js). | `route/delhiveryroutes.test.js`, `route/shipmentDraftRoutes.test.js`, `route/shipmentQuoteRoutes.test.js`, `src/pages/shipments/CreateShipmentPage.test.jsx`; provider calls mocked. | Verify required fields and exact pincode/city/state/zone source with client; serviceability in current tests is mocked/local. Provide provider contract and manual serviceability cases. |
| 3.1 zone | Store/derive destination zone used by rate selection. | PARTIALLY IMPLEMENTED | `DeliveryDestinationStep.jsx`; `customerPricingService.js`, `customerRateCardController.js`, `customerRateCard.js`. | `customerPricingService.test.js`, `customerRateCardRoutes.test.js`; fixture data only. | Authoritative zone table and pincode-to-zone ownership are not established. Client must approve/source zone rules; test boundary pincodes against that source. |
| 3.2 Shipper | Capture shipper/consignor company, contact, phone/email, address, city/state/pincode and applicable GST details. | PARTIALLY IMPLEMENTED | [`SavedPartyAddressesPage.jsx`](../../delhivery/src/pages/partyAddresses/SavedPartyAddressesPage.jsx), `SavedPartyAddressFormDialog.jsx`, shipment `SavedPartySection.jsx`; backend [`savedPartyAddressRoutes.js`](../route/savedPartyAddressRoutes.js), `savedPartyAddress.js`, draft snapshots. | `savedPartyAddressRoutes.test.js`, `partyAddressApi.test.js`, `SavedPartyAddressesPage.test.jsx`; local fake data. | Confirm party-specific mandatory fields and whether shipper records are owner-wide or customer-associated. Manual profile-to-shipment field review remains. |
| 3.2 reuse | Save and reuse shipper profiles during shipment entry. | IMPLEMENTED | `SavedPartySection.jsx`, `CreateShipmentPage.jsx`; `savedPartyAddressRoutes.js`, draft `shipperSnapshot`. | Saved-party route/API/page tests and `CreateShipmentPage.test.jsx`; no provider. | Manual acceptance should verify a saved profile populates the intended fields without changing the immutable draft snapshot unexpectedly. |
| 3.3 Consignee | Capture consignee/company/contact/address and applicable GST details. | PARTIALLY IMPLEMENTED | `RecipientDetailsStep.jsx`, `SavedPartySection.jsx`; saved-party API and draft `consigneeSnapshot`. | Customer/address and create-shipment tests; local data only. | Confirm required consignee fields and GST behavior; verify actual booking payload mapping and provider acceptance later. |
| 3.3 reuse | Retain/search/reuse consignee details for later shipments. | IMPLEMENTED | `SavedPartySection.jsx`, `SavedPartyAddressesPage.jsx`; owner-scoped `SavedPartyAddress` CRUD. | Saved-party backend/frontend/API tests; mocks. | Manual acceptance of filtering/association and record lifecycle. |
| 3.4 Pickup | Select same-as-shipper or separate pickup contact/address. | PARTIALLY IMPLEMENTED | `PickupWarehouseStep.jsx`, `SavedPartySection.jsx`, `CreateShipmentPage.jsx`; draft `pickupSnapshot`/`warehouseSnapshot`. | `CreateShipmentPage.test.jsx`, `shipmentDraftRoutes.test.js`; mocks. | Current flow also depends on a carrier-registered warehouse; confirm exact same-as-shipper semantics, address precedence, and required fields. Provider warehouse registration is not proven by local UI tests. |
| 3.5 Product/package | Collect description/category, box count, actual weight, dimensions, special handling and multiple packages. | PARTIALLY IMPLEMENTED | [`PackageDetailsStep.jsx`](../../delhivery/src/components/shipments/steps/PackageDetailsStep.jsx), draft `packageRows`; backend `shipmentDraftRouter.js`, booking snapshots. | `CreateShipmentPage.test.jsx`, `shipmentDraftRoutes.test.js`, `shipmentQuoteRoutes.test.js`; mocked/local. | Confirm special handling/category field map and exact per-package persisted/provider payload. Review legacy route versus draft payload parity. |
| 3.5 weight | Calculate volumetric/chargeable weight with applicable carrier rules. | CLIENT DECISION REQUIRED | `PackageDetailsStep.jsx`; `customerPricingService.js`; quote input contains chargeable weight. | Pricing and quote tests exercise fixtures, not carrier-specific rules. | Existing volumetric calculation uses a fixed divisor in the frontend; carrier-specific divisor, rounding, package aggregation, and billable increments require approved rules and provider documentation. |
| 3.6 payment/mode | Support prepaid/COD, order/COD amount, and Surface/Express. | PARTIALLY IMPLEMENTED | [`PaymentStep.jsx`](../../delhivery/src/components/shipments/steps/PaymentStep.jsx), `CreateShipmentPage.jsx`; `shipmentDraftRouter.js`, `shipmentQuoteRouter.js`, `appShipmentRouter.js`. | `CreateShipmentPage.test.jsx`, `shipmentQuoteRoutes.test.js`, `delhiveryroutes.test.js`; mocked. | Confirm whether COD collection may differ from order value, payment-mode field mappings, and partner-specific mode availability. |

### §4 Customer Management — Credit and Walk-in

| SRD ref | Individual requirement / acceptance criterion | Status | Frontend / backend implementation | Automated evidence and scope | Remaining work / evidence to complete |
|---|---|---|---|---|---|
| 4.1 Credit customer | Create, view, edit and search owner-scoped credit customer profiles with company/contact, billing/shipping, tax and credit data. | PARTIALLY IMPLEMENTED | [`CustomersPage.jsx`](../../delhivery/src/pages/customers/CustomersPage.jsx), `CustomerFormDialog.jsx`; [`customerRoutes.js`](../route/customerRoutes.js), `customer.js`, controller. | `customerRoutes.test.js`, `customerApi.test.js`, `CustomersPage.test.jsx`; fake data. | Confirm requiredness, identity key, tax/address semantics, and archival/deletion policy. Manual field-by-field acceptance needed. |
| 4.1 credit terms | Store credit terms/limit and assigned customer rate card. | PARTIALLY IMPLEMENTED | Customer model/controller and `CustomerRateCard` association. | Customer/rate-card route tests; no external finance system. | Exact credit term units, whether limits are mandatory, and who may change assignments require client decision and acceptance. |
| 4.1 outstanding | Show/maintain credit customer outstanding balance. | PARTIALLY IMPLEMENTED | `creditCustomerBillingService.js`, invoice/payment routes and report service derive outstanding from invoices/allocations. | `creditCustomerBillingRoutes.test.js`, invoice/payment tests; in-memory transaction fixtures. | Confirm whether balances are exclusively ledger-derived or imported from an external finance system; reconcile a client-approved statement. |
| 4.2 Walk-in | Support walk-in customer/profile selection and its standard pricing scope. | PARTIALLY IMPLEMENTED | `CustomersPage.jsx`, `CustomerFormDialog.jsx`, `CreateShipmentPage.jsx`; `Customer` category and `CustomerRateCard` walk-in scope. | Customer/rate-card/create-shipment tests. | Confirm whether each walk-in is a persistent customer or a shared account plus per-shipment contact. Confirm standard-card cardinality and selection rules. |
| 4.2 transactions | Preserve walk-in shipment/payment transaction details. | PARTIALLY IMPLEMENTED | Draft and booked shipment snapshots; payment records apply to credit invoices. | Shipment and billing/payment tests. | SRD transaction wording does not settle payment collection method, receipt/ledger source, or walk-in payment handling; client decision required. |

### §5 Customer Rate Master and pricing calculations

| SRD ref | Individual requirement / acceptance criterion | Status | Frontend / backend implementation | Automated evidence and scope | Remaining work / evidence to complete |
|---|---|---|---|---|---|
| 5.1 cards | Maintain customer-specific and standard Walk-in rate cards, including applicability/version data. | IMPLEMENTED | [`RateCardsPage.jsx`](../../delhivery/src/pages/rates/RateCardsPage.jsx), `CustomerRateCardController`, [`customerRateCardRoutes.js`](../route/customerRateCardRoutes.js), `customerRateCard.js`. | `customerRateCardRoutes.test.js`, `rateCardApi.test.js`, `RateCardsPage.test.jsx`; no live pricing source. | Client acceptance of effective dates, version lifecycle, and overlap/activation policy. |
| 5.2 zone/mode/slab | Configure rates by zone, shipping mode and weight slab. | PARTIALLY IMPLEMENTED | Rate card UI/model/controller and [`customerPricingService.js`](../services/customerPricingService.js). | `customerPricingService.test.js`, `customerRateCardRoutes.test.js`; fixture rates. | Confirm zone master, slab inclusive/exclusive boundaries, gaps, minimum charge, precision and rounding. |
| 5.3 additional weight | Apply additional-weight units/rates above included slab. | CLIENT DECISION REQUIRED | Customer pricing service carries configuration status and rejects incomplete rules. | Pricing/booking validation tests assert incomplete configurations block booking. | Client must supply increment, charge, rounding and slab application examples. No rule is inferred or bypassed. |
| 5.4 fuel/COD/other charges | Apply approved fuel, COD and other surcharge rules. | CLIENT DECISION REQUIRED | Rate-card surcharge configuration and pricing snapshot status exist. | Pricing tests cover configured/incomplete states, not client tariff policy. | Require fixed/percentage bases, charge order and examples from client. |
| 5.5 GST/tax | Calculate tax and retain tax basis in customer price/invoice snapshots. | CLIENT DECISION REQUIRED | Pricing snapshots and invoice tax configuration validation; `credit-billing-configuration.md`. | Booking/billing tests verify missing GST config blocks invoice/pricing where applicable. | Client must approve tax rates, inclusions, taxable components, rounding and invoice treatment. Do not treat a test-only sample rate as approved policy. |
| 5.6 booking price | Persist applied customer, rate card, pricing configuration and customer selling price; fail closed on incomplete/missing price. | IMPLEMENTED | `shipmentDraftRouter.js`, `shipmentQuoteRouter.js`, `customerPricingService.js`, booked shipment snapshots. | `shipmentQuoteRoutes.test.js` covers CONFIGURATION_REQUIRED/UNAVAILABLE/missing pricing, valid configured fixture, and snapshot content. | Manual acceptance using client-approved tariffs; no booking until the approved rule set exists. |

### §6 Multi-courier API integration

| SRD ref | Individual requirement / acceptance criterion | Status | Frontend / backend implementation | Automated evidence and scope | Remaining work / evidence to complete |
|---|---|---|---|---|---|
| 6.1 modular integration | Use a modular registry/adapter contract so providers can be added without rewriting booking flow. | IMPLEMENTED | `shipmentPartnerRegistry.js`, `courierQuotationService.js`, `delhiveryCourierAdapter.js`, `mockCourierAdapter.js`, `shipmentQuoteRouter.js`. | `courierQuotationService.test.js`, `delhiveryCourierAdapter.test.js`, `mockCourierAdapter.test.js`; injected adapters/mocks. | Manual architecture review and adapter contract acceptance. |
| 6.2 provider coverage | Integrate supported courier APIs for quote, booking, tracking/pickup/status operations. | EXTERNAL DEPENDENCY | Delhivery adapter and disabled configuration; registry; route handlers. | Adapter tests mock all carrier HTTP methods. The local mock explicitly reports no network request and no AWB. | Provider documentation, authorized credentials, serviceability/quote/booking test account, webhook configuration, client go-live authorization, and provider-confirmed end-to-end cases. Other courier adapters are not evidenced. |
| 6.3 safe configuration | Provider calls must be gated by explicit server configuration; no credential exposure. | IMPLEMENTED | `legacyDelhiveryAccess.js`, `directBookingConfigurationRoutes.js`, `shipmentPartnerRegistry.js`, server config. | `delhiveryroutes.test.js`, `directBookingConfigurationRoutes.test.js`, mock diagnostic tests. | Verify deployment secret-manager controls and provider activation process; current assessment made no live call. |

### §7 Rate comparison and manual selection

| SRD ref | Individual requirement / acceptance criterion | Status | Frontend / backend implementation | Automated evidence and scope | Remaining work / evidence to complete |
|---|---|---|---|---|---|
| 7.1 partners | Request and compare quote options from configured partners. | PARTIALLY IMPLEMENTED | `CreateShipmentPage.jsx`, quote controls; `courierQuotationService.js`, `shipmentQuoteRouter.js`. | `shipmentQuoteRoutes.test.js`, `courierQuotationService.test.js`; local/mock adapters. | Only locally configured mock is verified available; live Delhivery disabled and no other carrier confirmed. |
| 7.2 price detail | Show quote amount, partner/service and available cost breakdown/total. | PARTIALLY IMPLEMENTED | Quote batch snapshots and selected quote in draft; `CreateShipmentPage.jsx`. | Quote tests cover amount, currency, partner quote persistence and freshness with fake provider. | Validate partner-specific fee breakdown, surcharges and “total partner cost” definition against approved provider responses. |
| 7.3 ETA/serviceability | Show delivery estimate and serviceability with each quote. | PARTIALLY IMPLEMENTED | Quote serializer/UI includes ETA and serviceability fields. | Mock quote tests exercise optional ETA/serviceability. | Actual ETA/serviceability data require partner support and provider-confirmed examples; unavailable fields must remain clearly unavailable. |
| 7.4 manual selection | Require an operator to select a current quote before booking. | IMPLEMENTED | `CreateShipmentPage.jsx`; `shipmentQuoteRouter.js` select/book endpoints validate active batch, draft ownership, freshness/serviceability. | `shipmentQuoteRoutes.test.js`, `CreateShipmentPage.test.jsx`; mocks. | Manual UX acceptance; provider-side selection outcome only after approved live test. |
| 7.5 retain quote | Preserve quotes and selected partner quote as booking-time history. | IMPLEMENTED | Quote batches and `partnerQuoteSnapshot` / `estimatedPartnerCostSnapshot` on saved shipment. | `shipmentQuoteRoutes.test.js` snapshot and selection cases. | Acceptance that retention/visibility meets finance and operations needs. |

### §8 Profitability and historical pricing

| SRD ref | Individual requirement / acceptance criterion | Status | Frontend / backend implementation | Automated evidence and scope | Remaining work / evidence to complete |
|---|---|---|---|---|---|
| 8.1 selling price history | Keep customer selling rate and applied pricing/rate-card configuration fixed on each shipment. | IMPLEMENTED | `shipmentQuoteRouter.js` `buildBookedRecord`, `customerPricingService.js`, shipment snapshots; finance report. | Quote, billing, partner cost and report tests use immutable fixtures. | Client acceptance against approved rule configuration. |
| 8.2 estimated/final partner cost | Preserve quote estimate separately from provider-confirmed final cost. | IMPLEMENTED | `estimatedPartnerCostSnapshot`, `partnerCostSnapshot`, `partnerCostSourceSnapshot`; `partnerCostService.js`, partner-cost routes/page. | `partnerCostRoutes.test.js`, `financialReportExportService.test.js`, frontend partner-cost/report tests. | Confirm final invoice/settlement data source and complete a provider/account reconciliation example. |
| 8.3 GST and charges | Include applicable GST/surcharge and relevant partner costs in profitability. | CLIENT DECISION REQUIRED | `customerPricingService.js`, billing config, report service expose configuration/unavailable/provisional statuses. | Report/billing tests ensure unavailable amounts/statuses are represented; fixtures do not establish tax truth. | Client approval of tax/surcharge treatment and provider confirmation of included/excluded charge components. |
| 8.4 profit/margin | Calculate shipment/customer/partner profitability without substituting estimated for confirmed costs. | PARTIALLY IMPLEMENTED | `profitabilityReportService.js`, `financialReportExportService.js`, `PartnerCostManagement.jsx`, `ProfitabilityReports.jsx`. | `financialReportExportService.test.js`, `profitabilityReportRoutes.test.js`, frontend report tests; local fixture dataset. | Validate formulas and totals with client-approved ledger examples, including provisional and unavailable records. |
| 8.5 historical preservation | Later rate changes must not rewrite prior shipment prices/cost facts. | IMPLEMENTED | Shipment snapshots and append-only partner-cost reconciliation/history; billing invoice line snapshots. | Booking, partner cost and billing tests check snapshots/immutability patterns. | Manual migration/retention review against historical live records is outstanding; no production records were inspected. |

### §9 AWB generation and draft booking

| SRD ref | Individual requirement / acceptance criterion | Status | Frontend / backend implementation | Automated evidence and scope | Remaining work / evidence to complete |
|---|---|---|---|---|---|
| 9.1 legacy direct booking | Create a provider shipment and persist returned AWB/result. | PARTIALLY IMPLEMENTED | Legacy Create Shipment path in `CreateShipmentPage.jsx`/`App.jsx`; `POST /api/delhivery/shipments`, `appShipmentRouter.js`. | `delhiveryroutes.test.js`, `accountShipmentRoutes.test.js`; mocked provider. | Explicit Delhivery guard is tested; actual provider booking/AWB and document verification not done. Legacy route remains separate from quote workflow. |
| 9.2 editable draft | Save, reopen and update a shipment draft without creating a provider shipment/AWB. | IMPLEMENTED | `CreateShipmentPage.jsx`, draft API methods; `shipmentDraftRouter.js`, `App.jsx`. | `shipmentDraftRoutes.test.js`, `CreateShipmentPage.test.jsx`; in-memory local repository. | Manual acceptance of all six form sections and draft reopen/resume semantics. |
| 9.3 quote-to-book | Select a fresh quote belonging to current draft, validate selling price, snapshot customer/card/config/quote, then book through chosen adapter. | IMPLEMENTED | `shipmentQuoteRouter.js`, `courierQuotationService.js`, `CreateShipmentPage.jsx`. | `shipmentQuoteRoutes.test.js` includes stale/missing quote, pricing, snapshots, duplicate attempts and mocked adapter. | Live provider booking blocked until approved integration/credentials; local mock does not create shipment. |
| 9.4 states / pending AWB | Represent pending, confirmed booking and AWB-generated outcomes; allow pending-AWB visibility. | PARTIALLY IMPLEMENTED | `BOOKING_PENDING`, `OUTCOME_UNCONFIRMED`, `BOOKED_AWB_PENDING`, `AWB_GENERATED`; `dashboardService.js`, `ShipmentsPage.jsx`. | `shipmentQuoteRoutes.test.js`, `dashboardRoutes.test.js`, `OperationalMetricCards.test.jsx`, `ShipmentsPage.test.jsx`. | No verified real-provider AWB-later generation workflow is established. Manual lifecycle acceptance and provider capability evidence required. |
| 9.5 duplicate/recovery | Reserve before mutation, prevent duplicate submission, reconcile ambiguous results without blind retry. | IMPLEMENTED | `appShipmentRouter.js`, `shipmentQuoteRouter.js` reserve/state transitions and reconcile; idempotency key and CAS updates. | `delhiveryroutes.test.js`, `shipmentQuoteRoutes.test.js` ambiguous, definitive and concurrent cases. | Provider reconciliation contract must be proven against the actual adapter. No booking recovery should be accepted from mocks alone. |

### §10 Pickup scheduling

| SRD ref | Individual requirement / acceptance criterion | Status | Frontend / backend implementation | Automated evidence and scope | Remaining work / evidence to complete |
|---|---|---|---|---|---|
| 10.1 schedule pickup | Create pickup with date/time, location, package count/weight and linked shipments. | PARTIALLY IMPLEMENTED | [`PickupRequestsPage.jsx`](../../delhivery/src/pages/pickups/PickupRequestsPage.jsx), `PickupRequestDialog.jsx`; `pickupRequestRouter.js`, `createPickupRequestController.js`, `pickupRequest.js`. | `pickupRequestRoutes.test.js`, `PickupRequestsPage.test.jsx`; local workflows and injected dependencies. | Confirm whether local schedule is sufficient or carrier-confirmed pickup request is required. Verify payload and provider acceptance; no live carrier call made. |
| 10.2 lifecycle | View, reschedule, cancel and record pickup statuses/history. | IMPLEMENTED | Pickup page/router/model history, revisions, local transition guard. | Pickup route/UI tests cover CRUD-like lifecycle, owner scoping, status and read-only behavior. | Manual acceptance of permitted status transitions and cancellation semantics. |
| 10.3 carrier synchronization | Synchronize carrier pickup status and retain mapped history. | PARTIALLY IMPLEMENTED | `pickupRequestRouter.js` status mapping, `shipmentPartnerRegistry.js`, retry utility; carrier controller. | Tests inject adapters; configured mapping required, unknown states are rejected. | Provider-specific supported status list and end-to-end synchronization proof. Direct carrier creation remains a distinct mutation path and is not blindly retried. |

### §11 Credit customer monthly billing

| SRD ref | Individual requirement / acceptance criterion | Status | Frontend / backend implementation | Automated evidence and scope | Remaining work / evidence to complete |
|---|---|---|---|---|---|
| 11.1 monthly billing | Generate owner/customer scoped monthly invoices from eligible booked shipment snapshots. | PARTIALLY IMPLEMENTED | [`CreditCustomerBilling.jsx`](../../delhivery/src/pages/finance/CreditCustomerBilling.jsx), `creditCustomerBillingService.js`, routes, invoice model. | `creditCustomerBillingRoutes.test.js`, invoice service route tests and frontend billing tests; fake transactional models. | Confirm eligible status, invoice period cutoff, credit billing settings and client statement reconciliation. |
| 11.2 invoice contents/status | Preserve shipment line items, customer/rate/tax facts, totals, due dates and invoice status. | PARTIALLY IMPLEMENTED | Invoice schema/service and billing UI. | Billing tests cover snapshots, duplicates and GST configuration blocking. | Confirm required invoice fields, tax treatment and adjustments/credit-note rules. |
| 11.3 payment/outstanding | Record receipts/allocations, prevent duplicate payment, and derive outstanding. | IMPLEMENTED | `customerPaymentService.js`, payment/invoice routes and models; `PaymentManagement.jsx`. | Payment tests cover owner isolation, idempotency, allocations, over-allocation, duplicate IDs and balances. Mocks/transaction fakes only. | Manual finance acceptance against approved sample statements and payment evidence; no external payment gateway is shown. |

### §12 Tracking, NDR, RTO and notifications

| SRD ref | Individual requirement / acceptance criterion | Status | Frontend / backend implementation | Automated evidence and scope | Remaining work / evidence to complete |
|---|---|---|---|---|---|
| 12.1 tracking | Retrieve and display tracking timeline with normalized stored events and canonical status. | PARTIALLY IMPLEMENTED | [`ShipmentTrackingPage.jsx`](../../delhivery/src/pages/tracking/ShipmentTrackingPage.jsx), shipment detail; `shipmentTrackingRouter.js`, `providerStatusMappings.js`, webhook routes/controller. | `shipmentTrackingRoutes.test.js`, `trackingWebhookRoutes.test.js`, frontend tracking tests; provider responses mocked. | Verify real provider status/event shape, webhook authenticity, polling scope and event ordering with authorized test account. |
| 12.2 known statuses | Normalize mapped tracking status and keep unknown/unmapped statuses out of canonical buckets. | IMPLEMENTED | `providerStatusMappings.js`, `dashboardService.js`, account shipment response canonical status. | `providerStatusMappings.test.js`, dashboard/account shipment tests cover unknown statuses and delivered/in-transit parity. | Confirm mapping table with each carrier. |
| 12.3 Out for Delivery | Support OOD dashboard/detail only when provider mapping is verified. | EXTERNAL DEPENDENCY | `providerStatusMappings.js`, dashboard service and shipment list currently do not establish verified OOD provider mapping. | Tests do not claim OOD support. | Obtain authoritative provider status examples/documentation, approve mapping, then add mapping/count/list parity tests and manual provider evidence. Do not classify unknown strings as OOD. |
| 12.4 NDR | Detect/store NDR cases, show case details and support explicit case actions/status lifecycle. | PARTIALLY IMPLEMENTED | [`NdrManagementPage.jsx`](../../delhivery/src/pages/shipments/NdrManagementPage.jsx), `ndrService.js`, `ndrRouter.js`, NDR model. | `ndrRoutes.test.js`, `NdrManagementPage.test.jsx`; injected adapter/local events. | Validate real provider NDR payload/action/status support and authorization semantics. |
| 12.4 NDR dashboard parity | Count unique affected shipments and show the same unique shipment set, including eligible derived observations without GET writes. | IMPLEMENTED | `dashboardService.js`, `ndrService.js`, `ndrRouter.js`, NDR page and dashboard navigation. | Backend NDR route tests cover duplicate cases, derived observations, owner/date/status filters, GET read-only; frontend NDR test covers grouping and case visibility. | Manual comparison against a controlled local dataset and future provider samples. |
| 12.5 RTO | Detect/store RTO events/cases and preserve lifecycle/return shipment history. | PARTIALLY IMPLEMENTED | [`RtoManagementPage.jsx`](../../delhivery/src/pages/shipments/RtoManagementPage.jsx), `rtoService.js`, `rtoRouter.js`, model. | `rtoRoutes.test.js`, `RtoManagementPage.test.jsx` use explicit fixture events. | Validate actual carrier event mappings and returned shipment linking. |
| 12.5 RTO parity | Count unique RTO shipments, preserve related events and make dashboard/detail populations match; Active RTO uses lifecycle state. | IMPLEMENTED | `dashboardService.js`, `rtoService.js`, `rtoRouter.js`, Active RTO navigation/filter. | Backend RTO tests cover multi-event grouping, filters, owner scope, GET read-only; frontend RTO tests cover active/all lists. | Manual acceptance on approved lifecycle examples; no actual provider confirmation. |
| 12.6 notifications | Send operational notifications for tracking/NDR/RTO events. | NOT IMPLEMENTED | No complete notification delivery/recipient/preferences service was found. Existing `useToast` is in-app transient UI feedback, not operational notification delivery. | No end-to-end email/SMS notification tests found. | Define recipients, channel, templates, consent, retry/idempotency and provider dependencies; then implement and test. |

### §13 Operations dashboard

| SRD ref | Individual requirement / acceptance criterion | Status | Frontend / backend implementation | Automated evidence and scope | Remaining work / evidence to complete |
|---|---|---|---|---|---|
| 13.1 total bookings | Show owner-scoped booking count and matching detail list. | IMPLEMENTED | `dashboardService.js`, `dashboardController.js`, `DashboardPage.jsx`, `OperationalMetricCards.jsx`, `ShipmentsPage.jsx`. | `dashboardService.test.js`, `dashboardRoutes.test.js`, frontend metric/list tests. | Manual acceptance with known fixture counts; live counts not inspected. |
| 13.2 delivered / in transit | Count using canonical backend status and open the same eligible shipments in detail list. | IMPLEMENTED | `providerStatusMappings.js`, `dashboardService.js`, account shipment response, `ShipmentsPage.jsx`. | Dashboard/account shipment and frontend filter tests cover parity and unknown status exclusion. | Validate real provider mapping set per adapter. |
| 13.3 undelivered | Show undelivered count and corresponding filtered list. | PARTIALLY IMPLEMENTED | Dashboard status aggregation and shipment page filters. | Dashboard and shipment list tests cover common canonical group behavior. | Confirm SRD's precise inclusion/exclusion of exceptions, NDR and RTO with client and test full fixture set. |
| 13.4 OOD | Show Out for Delivery count and matching detail list. | EXTERNAL DEPENDENCY | No verified canonical OOD mapping; UI must not infer it. | No provider-backed OOD coverage. | Provider evidence, approved mapping and parity tests required. |
| 13.5 pickup pending | Show pickup pending count and corresponding pickup list. | PARTIALLY IMPLEMENTED | `dashboardService.js`, pickup request pages/router. | Dashboard and pickup tests use local status fixtures. | Confirm which local/carrier lifecycle values count as pending and whether card navigation applies filters correctly for all states. |
| 13.6 pending AWB | Count confirmed booked-pending-AWB states, exclude ordinary drafts, and open matching shipments. | IMPLEMENTED | Dashboard service, `OperationalMetricCards.jsx`, `ShipmentsPage.jsx` `isConfirmedPendingAwb`. | Backend dashboard and frontend metric/list tests. | Manual acceptance against confirmed state fixtures and later provider lifecycle evidence. |
| 13.7 NDR / RTO | Show unique shipment counts and matching details. | IMPLEMENTED | NDR/RTO services, dashboard cards, NDR/RTO pages. | Batch 1 tests described above; mocks/stored fixtures. | Manual count/list reconciliation on controlled dataset; provider confirmation remains outstanding. |
| 13.8 transit exceptions | Show exception count and matching exception details. | PARTIALLY IMPLEMENTED | Tracking event/status aggregation, dashboard and shipment list. | Status mapping and dashboard tests cover known mapped states, not a complete provider exception catalog. | Define exact eligible canonical states with client/provider; prove card navigation and date/status parity for every state. |
| 13.9 filters | Apply date and status filters consistently to metric counts and click-through lists. | PARTIALLY IMPLEMENTED | Dashboard query/filter controls, dashboard service and NDR/RTO APIs. | Dashboard, NDR/RTO and shipment filter tests cover implemented routes. | Acceptance matrix for every card × date range × status; some categories depend on provider mappings. |

### §14 Financial dashboard, reports and exports

| SRD ref | Individual requirement / acceptance criterion | Status | Frontend / backend implementation | Automated evidence and scope | Remaining work / evidence to complete |
|---|---|---|---|---|---|
| 14.1 customer revenue/profit | Provide customer-wise revenue and profitability. | PARTIALLY IMPLEMENTED | `ProfitabilityReports.jsx`, `profitabilityReportService.js`, report routes. | `profitabilityReportRoutes.test.js`, `financialReportExportService.test.js`, frontend report tests; local fixture data. | Confirm revenue recognition and profit formula against signed finance examples; unresolved tax/status values remain explicit. |
| 14.2 partner costs | Provide courier-wise cost and estimated-versus-final partner cost. | IMPLEMENTED | Partner-cost routes/service/model, report service and UI. | Partner-cost and report tests, no provider ledger integration. | Reconcile with actual carrier invoices/settlement files. |
| 14.3 shipment profitability | Show customer selling price versus partner cost and shipment-level profitability. | PARTIALLY IMPLEMENTED | Report service and report page/export. | Export/report tests verify data/filter semantics using fakes. | Resolve unavailable/provisional cost/tax cases and approve formula. |
| 14.4 outstanding/monthly billing | Show credit customer outstanding and monthly billing summary where source data exists. | IMPLEMENTED | Billing service/routes/UI and financial report service. | Billing, payment, report tests use simulated models and data. | Reconcile to client ledger and close billing policy decisions. |
| 14.5 filters | Filter reports by date, customer, partner and shipment status. | IMPLEMENTED | Report UI, shared API query, report service/export service. | `profitabilityReportRoutes.test.js`, export service tests, frontend report tests test filters/parity with mocks. | Manual acceptance of date boundaries/timezone and totals. |
| 14.6 CSV | Keep CSV export operational. | IMPLEMENTED | Frontend report export and report endpoint/service. | Report export tests cover CSV compatibility. | Manual spreadsheet-open test and representative finance signoff. |
| 14.7 Excel/PDF | Export filtered dataset to `.xlsx` and PDF with totals/statuses and appropriate formatting. | IMPLEMENTED | `financialReportExportService.js`, report routes, `ProfitabilityReports.jsx`. | Export service/routes tests verify generation, filter parity, totals, empty/unavailable and owner/auth behavior. | Manual review of formatting, large report usability, and client acceptance; exported data remains only as reliable as source snapshots. |

### §15 Database and historical data requirements

| SRD ref | Individual requirement / acceptance criterion | Status | Frontend / backend implementation | Automated evidence and scope | Remaining work / evidence to complete |
|---|---|---|---|---|---|
| 15.1 retain history | Retain booking/tracking/pickup/financial history needed for operations and reporting. | PARTIALLY IMPLEMENTED | `appShipment.js`, `pickupRequest.js`, tracking event snapshots, NDR/RTO models, invoice/payment models, embedded audit/history. | Route/service tests assert persistence/history in fake repositories. | No production retention window, archival, deletion schedule or capacity policy established. |
| 15.2 immutable facts | Preserve historical customer rate, quote, partner cost, invoice and payment facts when master data changes. | IMPLEMENTED | Draft/booked snapshots, invoice lines, payment allocations, partner cost history. | Booking, billing, payment and partner cost tests. | Manual historical migration/consistency review cannot be done without approved non-production dataset. |
| 15.3 compatibility | Keep legacy records and booking path readable while new workflows are introduced. | PARTIALLY IMPLEMENTED | `AppShipment` legacy mixed record, account response serialization, legacy and draft routes. | Account and legacy booking tests plus draft tests. | Two booking implementations have overlapping concerns; define migration/deprecation policy and test representative existing records without modifying them. |
| 15.4 backups | Maintain recoverable database backup and restore process. | EXTERNAL DEPENDENCY | [`DATABASE_BACKUP_RESTORE.md`](../docs/DATABASE_BACKUP_RESTORE.md), `backupMetadata.js` metadata helper only. No backup/restore app route or infrastructure integration. | `backupMetadata.test.js` validates metadata shape/sanitization only; no backup artifact or restore was performed. | Hosting/provider/snapshot schedule, credentials/secret manager, encrypted storage, retention, RPO/RTO, isolated restore target and operator approvals required. |

### §16 General system requirements

| SRD ref | Individual requirement / acceptance criterion | Status | Frontend / backend implementation | Automated evidence and scope | Remaining work / evidence to complete |
|---|---|---|---|---|---|
| 16.1 authentication | Authenticate users and protect operational/business routes. | IMPLEMENTED | `App.jsx`, API client/session; backend `requireSession.js`, route middleware. | Auth route and route tests assert unauthenticated rejection. | Manual session expiry/login/logout acceptance and deployment TLS/session-secret review. |
| 16.2 owner isolation | Scope customer, shipment, finance, reports, pickup and exception records to authenticated owner. | IMPLEMENTED | Owner-derived filters across route/service modules; no trusted request-body owner. | Route suites repeatedly test foreign-owner 404/empty and tenant scoping. All local fake data. | Security review across every mounted endpoint plus adversarial manual test. |
| 16.3 RBAC | Enforce role/permission authorization where required. | CLIENT DECISION REQUIRED | RBAC models/routes/policy and authorization middleware retained; disabled by default. | `rbacRoutes.test.js`, compatibility and owner-isolation tests. | Client approval of role matrix, assignment model and activation date. Do not activate RBAC before approval. |
| 16.4 search | Search shipments/AWB/customer/mobile/pincode and operational records with limits/pagination. | IMPLEMENTED | `operationalSearchService.js`, search route, `Topbar.jsx`, result navigation and existing page search. | `operationalSearchRoutes.test.js`, `Topbar.test.jsx`, existing shipment/NDR/RTO tests. | Manual search UX/PII authorization and index review. |
| 16.5 logs/audit | Record safe API request/error logs and business mutation audit with actor, owner, entity, time and correlation. | PARTIALLY IMPLEMENTED | `requestLogging.js`, `businessAudit.js`, `businessAuditEvent.js`, audit route; embedded finance/pickup/booking history. | `requestLogging.test.js`, `businessAudit.test.js`, route audit tests. | Audit coverage is not transactionally uniform across all mutation paths; inspect deployment logger sink/retention, complete route-by-route coverage and client audit retention policy. |
| 16.6 retries/recovery | Use bounded retries only for safe/idempotent operations; reconcile ambiguous booking and prevent duplicate financial mutations. | IMPLEMENTED | [`SAFE_PROVIDER_RETRIES.md`](../docs/SAFE_PROVIDER_RETRIES.md), `safeReadRetry.js`, booking reconciliation, provider read sync. | `safeReadRetry.test.js`; booking ambiguity/concurrency tests; invoice/payment duplicate tests. All provider behavior mocked. | Cross-process background retry jobs are not implemented; provider Retry-After and adapter-specific retry classifications need provider contract review. |
| 16.7 duplicate prevention | Prevent duplicate booking/invoice/payment and preserve idempotency keys/references. | IMPLEMENTED | Booking reservation/idempotency, unique invoice/payment constraints, payment allocation checks. | Booking, billing and payment route tests include parallel duplicate cases. | Verify deployed indexes and real provider idempotency/reconciliation semantics in staging. |
| 16.8 API error handling | Return safe errors and avoid leaking tokens/credentials or full sensitive payloads. | PARTIALLY IMPLEMENTED | `requestLogging.js`, error utilities and route-level safe error envelopes. | Request logging tests cover redaction/error codes/logger failure. | Perform full response/log redaction review and production log sink/access/retention check. |
| 16.9 backup/restore | Restrict restore to authorized operators and maintain recovery procedure. | EXTERNAL DEPENDENCY | No app-triggered restore; operator runbook and metadata helper only. | Metadata unit tests only. | Actual infrastructure owner must demonstrate secured backup and isolated restore; production restore must have incident/client approval. |

### §17 Phased development approach

The SRD phases are assessed as delivery groupings, not independent certification. Their detailed status appears below in [Phase-wise completion](#phase-wise-completion).

| SRD ref | Requirement | Status | Evidence / completion evidence |
|---|---|---|---|
| 17.1 Phase 1 Core Booking | Booking form, customers, rate master, partner comparison, AWB/drafts. | PARTIALLY IMPLEMENTED | Source and tests listed in §§3–9; approved tariff rules and carrier-backed acceptance are missing. Phase accepted only after client field/rule review and provider/manual scenarios. |
| 17.2 Phase 2 Operations | Pickup, tracking, NDR/RTO and operations dashboard. | PARTIALLY IMPLEMENTED | §§10, 12, 13 source/tests; provider status support and notifications remain. Need operational acceptance with provider test data. |
| 17.3 Phase 3 Finance | Monthly billing, cost/profitability and finance reports. | PARTIALLY IMPLEMENTED | §§11, 14; tax/final costs/ledger decisions need client reconciliation and signoff. |
| 17.4 Phase 4 Advanced | Advanced security/analytics/backup or other advanced items listed in phase plan. | PARTIALLY IMPLEMENTED | RBAC is present but disabled; search/audit/logging/retry are partly or fully coded; infrastructure backup and restore not provisioned. Obtain client security approval and infrastructure evidence. |

### §18 Development notes and provider-dependent requirements

| SRD ref | Individual requirement / acceptance criterion | Status | Evidence / remaining work |
|---|---|---|---|
| 18.1 modular / progressive integration | Build provider support modularly and discover provider capabilities from documentation rather than assuming them. | IMPLEMENTED | Registry/adapter architecture and mocked adapter contracts exist. Review adapter changes when new provider docs are supplied. |
| 18.2 provider capability | Provider API functionality, status semantics, webhook behavior, rate/ETA, booking and pickup capabilities must be based on partner documentation/testing. | EXTERNAL DEPENDENCY | Delhivery adapter exists but is disabled; verified local configuration uses `MOCK_LOCAL`. Obtain current provider docs, credentials and staging account; record manual provider evidence per operation. |
| 18.3 staged acceptance | Validate local/test behavior before live activation and preserve client-approved limits/decisions. | PARTIALLY IMPLEMENTED | Local mock diagnostics and safety gates exist; no complete signed acceptance package or provider staging run in this assessment. | Client signoff, controlled staging plan, rollback/reconciliation plan and acceptance evidence required. |

### Expanded bullet-level trace for explicit SRD lists

The following rows split SRD enumerations into independently verifiable requirements so a parent feature is not treated as complete merely because one part works.

| SRD ref / bullet | Requirement | Status | Implementation / test evidence | Remaining evidence |
|---|---|---|---|---|
| 6 / Pincode Serviceability | Check destination serviceability. | EXTERNAL DEPENDENCY | Legacy pincode controller and UI; mocked route tests. | Live partner capability, authorized credentials and known serviceability cases. |
| 6 / Rate Enquiry | Fetch partner rates and charges. | PARTIALLY IMPLEMENTED | Adapter `quote()` and quote endpoint; quote service tests. | Live rate response evidence for each enabled provider. |
| 6 / Shipment Booking | Create shipment with selected partner. | PARTIALLY IMPLEMENTED | Draft quote/selection/book path plus legacy guarded direct endpoint; booking tests. | Real selected-partner booking in approved sandbox and manual reference reconciliation. |
| 6 / AWB Generation | Receive and store the AWB. | PARTIALLY IMPLEMENTED | Booking record and AWB state persistence; mocked booking tests. | Provider-confirmed AWB creation, duplicates and pending-AWB lifecycle. |
| 6 / Shipping Label | Retrieve and print a partner shipping label. | PARTIALLY IMPLEMENTED | Existing document routes and label UI; document route tests. | Verify selected partner label endpoint/format and print output with provider test AWB. |
| 6 / Pickup | Schedule pickup request. | PARTIALLY IMPLEMENTED | Local pickup router and legacy provider controller. | Provider capability and selected-partner confirmation. |
| 6 / Tracking | Fetch movement and status. | PARTIALLY IMPLEMENTED | Tracking sync/webhook and stored event history; mock adapter route tests. | Provider status/event contract and manual test shipment. |
| 6 / Delivery, NDR, RTO | Receive delivery and exception updates. | PARTIALLY IMPLEMENTED | Canonical mappings, webhook, NDR/RTO services and pages; local tests. | Carrier-specific status/action support and mapped samples for every configured provider. |
| 6 / Cancellation | Cancel eligible provider shipments. | EXTERNAL DEPENDENCY | No complete selected-adapter shipment cancellation workflow established; local pickup cancellation is distinct. | Provider cancellation API/cancellation eligibility rules, client workflow and idempotency contract. |
| 6 / API documentation capability | Integrate only capabilities documented by each partner. | EXTERNAL DEPENDENCY | Adapter architecture exists; Delhivery live adapter disabled and other partners absent. | Current provider API documents and approved capability matrix. |
| 7 / historical delivery performance | Include historical delivery performance in manual partner selection where available. | NOT IMPLEMENTED | No verified partner performance ranking/ETA analytics source found. | Define metric, sample minimum, time window and data source; provider history must be available. |
| 8A / partner identity and API reference | Retain courier partner, API quoted rate and response reference. | PARTIALLY IMPLEMENTED | Quote snapshots retain partner and amount; `partnerQuoteSnapshot`. | Persist/use sanitized provider response reference consistently; do not store sensitive raw response payloads. Test actual provider correlation. |
| 8A / original charges | Retain original quoted charges and surcharge breakdown. | PARTIALLY IMPLEMENTED | Quote breakdown snapshot is supported. | Verify each adapter maps every returned charge and does not collapse unknown fee components. |
| 8A / final partner invoice cost | Store final invoice cost separately from estimate. | IMPLEMENTED | Partner cost confirmation/reconciliation routes and snapshots. | Reconcile against actual carrier invoice/settlement evidence. |
| 8A / fuel and additional charges | Store fuel surcharge and other final charges. | PARTIALLY IMPLEMENTED | Partner-cost components are modeled/accepted. | Confirm provider billing fields and surcharge categorization; client approval for allocation rules. |
| 8B / customer and category | Record customer name/category with the shipment selling rate. | IMPLEMENTED | Customer snapshot and booked record. | Manual review of client customer/category edge cases. |
| 8B / applicable rate card | Record the exact card/version used. | IMPLEMENTED | Rate-card snapshot and pricing snapshot. | Client acceptance of card version/effective-date behavior. |
| 8B / selling charges and tax | Record selling rate, applicable charges, GST and final customer invoice amount. | PARTIALLY IMPLEMENTED | Pricing and tax snapshots plus invoice generation; billing guard. | GST/surcharge decisions and invoice calculation examples remain blocked by client rules. |
| 8C / gross profit formula | Gross profit uses revenue excluding GST less partner cost excluding recoverable GST. | CLIENT DECISION REQUIRED | Report service computes from available normalized snapshots/states. | Confirm recoverable-tax classification and exact source fields with finance; reconcile expected results. |
| 8C / profit margin formula | Margin is gross profit divided by customer revenue excluding GST. | CLIENT DECISION REQUIRED | Report calculations/statuses exist. | Approve formula, zero/negative revenue behavior, rounding and provisional-state rules. |
| 9 Option A / label | Save, submit, store partner reference/AWB, retrieve and print label. | PARTIALLY IMPLEMENTED | Booking/label routes and UI exist; provider calls mocked. | Prove one approved provider end-to-end, including label retrieval and print review. |
| 9 Option B / later AWB | Draft can later generate AWB and appear under Pending AWB Generation. | PARTIALLY IMPLEMENTED | Drafts and Pending AWB dashboard/detail exist. | A complete provider-supported later-AWB generation action/state transition is not demonstrated; provider semantics required. |
| 9 / distinct statuses | Maintain Draft, Booking Pending, Booked and AWB Generated states. | IMPLEMENTED | Draft/booking attempt and bookingStatus state representation. | Map provider states and manually accept all transitions. |
| 9 / duplicate AWB | Prevent duplicate booking and duplicate AWB generation. | IMPLEMENTED | Reservation/idempotency/reconciliation and compare-and-set persistence. | Confirm real provider idempotency and replay behavior in sandbox. |
| 10 / pickup date | Store requested pickup date. | IMPLEMENTED | Pickup model/router and pickup form. | Manual timezone/date boundary acceptance. |
| 10 / pickup time slot | Store time slot From/To. | PARTIALLY IMPLEMENTED | Current local request validates a pickup time value; schema/UI do not establish both interval endpoints. | Client/provider slot semantics and a From/To field/payload acceptance. |
| 10 / address/contact/mobile | Record pickup address, contact and phone. | IMPLEMENTED | Location snapshot with validation. | Carrier format confirmation. |
| 10 / shipment count/packages/weight | Record number of shipments, package count and total weight. | PARTIALLY IMPLEMENTED | Pickup stores linked shipment refs, package count and total weight. | Confirm whether displayed shipment count is derived or stored and reconcile links with exact packages. |
| 10 / instructions | Capture pickup instructions. | PARTIALLY IMPLEMENTED | Local pickup model/request does not establish complete instructions UI/API coverage. | Add/confirm instruction field and provider mapping if required. |
| 10 / statuses | Support Scheduled, Assigned, Picked Up, Failed, Rescheduled. | PARTIALLY IMPLEMENTED | Local Scheduled/Completed/Cancelled/Failed states and reschedule history; provider mapping rejects unknown statuses. | Model/approve exact transitions and map provider values for Assigned/Picked Up/Rescheduled; no invented mappings. |
| 11 / customer statements | Produce customer-wise shipment statements. | PARTIALLY IMPLEMENTED | Monthly billing/report views and invoice line items. | Client statement layout and reconciliation sample. |
| 11 / billing cycle | Configure monthly cycle and billing period. | PARTIALLY IMPLEMENTED | Customer billing configuration and invoice period route. | Confirm cutoff/calendar, timezone, closing date and billable status. |
| 11 / consolidated invoices | Generate a consolidated customer invoice. | IMPLEMENTED | Billing service, invoice model/routes/UI. | Finance signoff on invoice template and real sample totals. |
| 11 / GST and shipment breakdown | Include GST calculation and shipment-wise charges. | CLIENT DECISION REQUIRED | Invoice lines and GST configuration validation exist. | Approved GST/charge rules and accepted invoice example. |
| 11 / debit-credit adjustments | Record debit/credit adjustments. | NOT IMPLEMENTED | No distinct adjustment/credit-note workflow/model found. | Define adjustment types, approval, linkage and audit/accounting treatment. |
| 11 / payment receipt | Record payment receipts and allocations. | IMPLEMENTED | Customer payment service/routes/model/UI. | Manual reconciliation with client payment process; no gateway integration evidenced. |
| 11 / outstanding and due dates | Track outstanding amount and due date. | PARTIALLY IMPLEMENTED | Derived invoice outstanding and due-date fields/statuses. | Confirm due-date policy, overdue calculations, aging and customer statement values. |
| 11 / payment status | Track invoice/payment status. | IMPLEMENTED | Invoice/payment status and allocation workflow. | Client finance acceptance of partial, full, reversed and adjusted cases. |
| 11 / billable shipment eligibility | Invoice completed or otherwise configured billable shipments. | PARTIALLY IMPLEMENTED | Invoice service checks configured shipment states and available snapshots. | Client approval of billable statuses and cutoff behavior. |
| 11 / walk-in immediate collection | Handle walk-in payment at shipment transaction. | PARTIALLY IMPLEMENTED | Customer category and shipment details exist; credit payment management is implemented. | Immediate payment workflow/payment method and receipt rules are not established. |
| 12 / tracked status catalog | Support Booked, Pickup Pending/Picked Up, In Transit, OOD, Delivered, Delivery Failed, NDR, RTO Initiated/Delivered, Delayed, Lost/Damaged where reported. | PARTIALLY IMPLEMENTED | Canonical status mapping, tracking store and dashboards. | OOD, delayed, lost/damaged and some pickup/exception mappings need provider-confirmed meanings; keep unknown statuses unclassified. |
| 12 / notifications | Notify pickup failure, delivery failure, delay, transit exception, NDR, RTO and critical events. | NOT IMPLEMENTED | No outbound notification delivery subsystem found. | Notification policies, channels, recipients, templates and event idempotency. |
| 12 / webhook and polling | Use webhooks where available and scheduled polling as fallback. | PARTIALLY IMPLEMENTED | Webhook endpoints and explicit/manual sync routes exist. | No scheduled polling worker/scheduler was evidenced; webhook availability/auth contract varies by carrier. Define cadence and operational monitoring. |
| 13 / each dashboard figure clickable | Each figure opens corresponding detailed shipment list. | PARTIALLY IMPLEMENTED | Metric cards/navigation and filtered shipment/NDR/RTO/pickup pages. | Implemented cards have tests; OOD and some transit-exception/pickup definitions remain. Complete every-card detail-list acceptance matrix. |
| 14 / partner performance | Report courier partner-wise performance. | NOT IMPLEMENTED | Partner cost and quote data exist, but no validated performance ranking/report. | Define delivery success, delivery time, exception denominator and period; requires sufficient tracking history. |
| 14 / quote vs final invoice | Report API quoted cost versus final invoice cost. | IMPLEMENTED | Profitability report/partner cost model and exports. | Reconcile with actual carrier invoice records. |
| 14 / daily/weekly/monthly profit | Report profit across daily, weekly and monthly periods. | PARTIALLY IMPLEMENTED | Report period/date filters and monthly billing summary. | Confirm period grouping/timezone and verify daily/weekly/monthly totals with finance; do not infer missing costs. |
| 14 / customer revenue/profit, partner cost, selling vs cost, shipment profit, outstanding, monthly billing | Provide each enumerated financial report. | PARTIALLY IMPLEMENTED | Financial report service/UI and billing views. | Partner performance and approved financial semantics remain; verify each report separately with signed fixtures. |
| 14 / filters/export | Filter reports by date/customer/partner and export Excel/PDF. | IMPLEMENTED | Authenticated owner-scoped report/export routes and UI. | Backend tests cover filter parity and file generation; manually inspect rendered exports. |
| 15 / master collections | Maintain Customer Master, Shipper/Consignee, Pickup Addresses, Rate Cards and partner rate responses. | IMPLEMENTED | Customer/address/rate-card models; quote snapshots embedded in shipment. | Validate backup/retention and actual partner quote history; no separate quote collection is required by current design but retention must be accepted. |
| 15 / shipment/AWB | Maintain shipment records and AWB details. | IMPLEMENTED | Shipment model and account routes. | Verify legacy historical record integrity in authorized isolated copy. |
| 15 / API request/response logs | Retain API request/response logs. | PARTIALLY IMPLEMENTED | Structured request metadata logs and safe error codes; provider raw bodies are not logged. | Clarify safe audit evidence/retention expectations. Do not store credentials or full PII payloads; provider correlation references may be retained safely. |
| 15 / tracking and pickup history | Retain tracking and pickup history. | IMPLEMENTED | Embedded tracking events and pickup history. | Operational retention/archival policy and provider data reconciliation. |
| 15 / invoices, partner costs, payments, profitability | Retain financial records needed for reports. | IMPLEMENTED | Invoice/payment/partner cost models and immutable snapshots. | Confirm retention period, archive/export and recovery evidence. |
| 16 / status filters | Provide shipment status filters. | IMPLEMENTED | Shipment list filters using canonical status plus pending AWB; NDR/RTO filters. | Manual full status matrix against each provider's approved mappings. |
| 16 / data export | Provide data export. | IMPLEMENTED | Financial CSV/XLSX/PDF exports and shipping document exports. | Clarify whether SRD intends other operational datasets to be exportable; test actual file rendering. |
| 16 / configurable partner integrations | Configure courier integrations without source changes or exposing secrets. | PARTIALLY IMPLEMENTED | Adapter registry and environment/config gated capabilities. | Provider onboarding/config process and secret-manager controls are not evidenced for deployment. |
| 17 Phase 4 / advanced analytics | Add advanced analytics. | NOT IMPLEMENTED | No broad advanced analytics module beyond existing dashboards/reports. | Define Phase 4 metrics, data sources and acceptance. |
| 17 Phase 4 / performance ranking | Rank courier performance. | NOT IMPLEMENTED | No accepted ranking algorithm or performance report. | Client definition and sufficiently reliable provider history. |
| 17 Phase 4 / automated selection | Add automated courier selection after manual initial selection. | NOT IMPLEMENTED | Current quote flow requires operator selection. | Client approval of optimization objective, constraints and fallback; never infer a ranking rule. |
| 17 Phase 4 / additional integrations | Integrate additional partners. | EXTERNAL DEPENDENCY | Modular registry supports adapters; only local mock is verified active. | Partner selection, docs, sandbox credentials and implementation/acceptance. |
| 18 / architecture and DB review | Review architecture and database structure before development begins. | PARTIALLY IMPLEMENTED | Phase 1 technical plan and milestone data contracts document architecture/contracts; implementation has since evolved. | Update and approve current architecture/data model review against shipped source. |
| 18 / modular/scalable | Keep system modular for partners and future requirements. | IMPLEMENTED | Adapter registry, service/controller separation and additive snapshots. | Load/performance and deployment architecture review for production scale. |
| 18 / progressively refine details | Refine field specs, screen designs, business rules, mappings and report formats progressively. | PARTIALLY IMPLEMENTED | Phase plans, data-contract and client decision lists, code-level validation. | Track and sign remaining decisions; several rules and manual designs are not approved. |
| 18 / discover dependencies | Identify partner API limits, webhook availability and credentials during technical discovery. | EXTERNAL DEPENDENCY | Risks and dependencies documented; Delhivery live adapter disabled. | Complete provider discovery with partner docs, account credentials and client-authorized staging. |

## Phase-wise completion

| Phase | Scope | Current status | What is implemented | Exit gaps |
|---|---|---|---|---|
| Phase 1 — Core Booking | Booking fields, Credit/Walk-in customers, rate master, multi-carrier quote comparison, booking/AWB/draft. | **PARTIALLY IMPLEMENTED** | Customer, saved party and rate-card APIs/UI; draft save/resume, quote selection, customer pricing validation, snapshots, mock booking, legacy direct-booking guard, duplicate protection and reconciliation. | Client rate/tax/weight rules; field parity; real provider quote/booking/AWB acceptance; document and old-record compatibility manual review. Two active paths need a documented canonical workflow policy. |
| Phase 2 — Operations | Pickup, tracking, NDR/RTO, notifications and operational dashboard. | **PARTIALLY IMPLEMENTED** | Pickup request and local lifecycle, tracking event store/webhook, NDR/RTO cases/actions, dashboard metric parity for implemented statuses, active RTO/Pending AWB, filters. | OOD provider mapping; notifications; live partner status/action/pickup confirmation; complete exception-state matrix and manual card/detail reconciliation. |
| Phase 3 — Finance | Credit monthly billing, invoices/payments, partner cost, profitability reports and exports. | **PARTIALLY IMPLEMENTED** | Invoice/payment routes and idempotency, partner cost confirmation/reconciliation, profitability report, filters, CSV/XLSX/PDF export. | Client-approved tax/surcharge/formula semantics; accounting/statement reconciliation; provider final cost source; manual export formatting acceptance. |
| Phase 4 — Advanced | RBAC, global search, audit/logging, retries, backup/restore and advanced reporting. | **PARTIALLY IMPLEMENTED** | Owner-scoped operational search; disabled-by-default RBAC implementation; business audit/event and request logging; bounded safe read retries; backup/restore runbook and metadata validation. | RBAC approval; complete audit coverage/sink retention; cross-instance job/lease if scheduled retries are required; actual hosting backup/snapshot and isolated restore exercise. |

## Cross-cutting assessment

### Security and owner isolation

Authenticated middleware and owner-scoped queries cover the core API families. Automated route tests include unauthorized access and cross-owner cases for shipment, customer/address/rate-card, quote, pickup, NDR/RTO, invoices/payments, partner cost, reports, search and audit. This is **automated local evidence**, not a penetration test. RBAC authorization code exists but remains disabled by explicit project context pending client approval. The legacy direct Delhivery route is fail-closed on its server configuration; the authenticated readiness endpoint returns only one boolean; the frontend fails closed while loading or if readiness is invalid/unavailable.

Remaining security acceptance: enumerate every mounted route and test cross-owner object references, review deployment TLS/session secrets and log access/retention, approve RBAC roles, and verify secret-manager boundaries. No secrets or production data were inspected for this report.

### Historical data preservation

New shipment records retain customer/rate card/pricing and selected quote snapshots; partner cost has estimated/final distinction; invoices retain line snapshots; payment allocations and pickup/tracking/NDR/RTO histories are stored. Existing legacy shipment model and route remain present, and there is no evidence of a production migration or historical-data audit in this read-only assessment. No records were read. The deployment must verify indexes, old record serialization, retention/deletion policy, and migration compatibility in an isolated copy.

### Export functionality

CSV remains available and the financial report export service supports XLSX and PDF using the same filtered report dataset/calculation semantics, with owner-scoped endpoints and status-aware unavailable/provisional values. Backend tests cover generation, filters, totals, empty/unavailable values, owner isolation and authorization. Frontend report tests pass in the run below. Manual inspection of generated files in spreadsheet/PDF viewers and finance signoff are still needed.

### Dashboard count/detail consistency

Backend aggregation and detail endpoints have matching canonical status logic for Delivered/In Transit and confirmed Pending AWB. NDR and RTO aggregate unique shipment populations; NDR includes eligible derived observations without writing during GET; RTO preserves event grouping and Active RTO lifecycle filtering. Automated tests cover duplicate cases/events, date/status/owner filters, and read-only GET behavior. OOD remains excluded because verified provider mappings are unavailable. Transit-exception and pickup-pending definitions still need a complete approved status/filter matrix. All count assertions use local fixtures rather than actual account/provider data.

### Audit and structured logging

Request logs include correlation ID, method, safe route/status/duration/error code with redaction tests and failure isolation. Business audit utilities cover listed mutation families and owner/actor association; finance events are embedded/transactional where needed. Coverage is not fully uniform across every legacy controller or transaction. Confirm sink durability, retention, access, alerting, and any gaps in the route mutation inventory before marking this complete.

### Retry and recovery safety

Bounded retries apply to quote, reconciliation, tracking/pickup sync and NDR status reads only. Booking submission, invoice generation, payment allocation, pickup creation/cancellation and NDR actions are not blindly retried. Existing booking idempotency/reservation and reconciliation remain. In-process single-flight plus conditional persistence protects common duplicates; it is not a cross-instance durable lock/job queue. Provider-specific retry-after semantics and live idempotency must be validated before production use.

### Backup and restore readiness

Only documentation and pure metadata validation exist. The repository shows Mongo connection configuration but no deployment/hosting manifest, automated backup schedule, snapshot API, storage target or restore automation. No backup/restore was attempted. An infrastructure owner must identify provider capability, secret-managed credentials, encryption, retention, RPO/RTO, access controls, and demonstrate restore into isolated non-production. Production restore requires explicit incident/client approval and an operator recovery plan; ordinary users have no application restore control.

## Automated test evidence

### Safe backend suite

Executed `npm.cmd test` in `D:\delhivery-backebnd`, which runs the repository's `test:safe` Node test list. Result: **196 tests passed, 0 failed**. The tests use fake/in-memory models and injected mocks; they did not connect to MongoDB or call live providers.

Representative coverage:

- Shipment/auth/owner: `route/accountShipmentRoutes.test.js`, `route/delhiveryroutes.test.js`.
- Customers, addresses and rate cards: `route/customerRoutes.test.js`, `route/savedPartyAddressRoutes.test.js`, `route/customerRateCardRoutes.test.js`, `services/customerPricingService.test.js`.
- Draft/quotes/booking recovery: `route/shipmentDraftRoutes.test.js`, `route/shipmentQuoteRoutes.test.js`, `services/courierQuotationService.test.js`.
- Pickup/tracking: `route/pickupRequestRoutes.test.js`, `route/shipmentTrackingRoutes.test.js`, `route/trackingWebhookRoutes.test.js`.
- NDR/RTO/dashboard: `route/ndrRoutes.test.js`, `route/rtoRoutes.test.js`, `services/dashboardService.test.js`, `route/dashboardRoutes.test.js`.
- Billing, payment, partner cost and reports/export: `route/creditCustomerBillingRoutes.test.js`, `route/partnerCostRoutes.test.js`, `route/profitabilityReportRoutes.test.js`, `services/financialReportExportService.test.js`.
- Search/audit/logging/RBAC/retry/backup metadata: `route/operationalSearchRoutes.test.js`, `route/businessAuditRoutes.test.js`, `utils/businessAudit.test.js`, `utils/requestLogging.test.js`, `route/rbacRoutes.test.js`, `utils/safeReadRetry.test.js`, `utils/backupMetadata.test.js`.

### Frontend suite

Executed `CI=true npm.cmd test -- --watchAll=false --runInBand --silent` in `D:\delhivery`. Result: **22 suites passed, 1 suite failed; 187 tests passed, 1 test failed**. Passing suites include customer/rate/address pages, booking and quote UI, tracking, pickup, NDR/RTO, Pending AWB/Active RTO dashboard cards, finance/report exports, and API clients.

Unresolved failure: `src/App.test.js` test **“warehouse and shipment creation wait for acceptance; failed cancellation preserves state”** waits for the legacy provider error “Invalid warehouse” after pressing “Create shipment.” The test fixture does not establish authenticated direct-booking readiness as enabled; the current UI fails closed and keeps the direct action disabled, so the legacy mocked response is never consumed. This is a stale/conflicting test expectation after the booking safety integration and should be updated in a separate authorized fix. This audit made no application or test edits. React `act(...)` warnings appeared in earlier non-silent run; they were warnings, not additional failures in the serial rerun.

No production build was run: this task authorizes only creation of this report, and the frontend build writes artifacts outside the writable backend root. No browser/manual acceptance was performed.

## Duplicate or conflicting implementations

1. **Legacy direct booking:** `POST /api/delhivery/shipments` in `services/appShipmentRouter.js` / `route/accountShipmentRoutes.js` directly submits to Delhivery after the fail-closed flag check. UI action is readiness-gated. It does not flow through quote selection or the mock adapter.
2. **Draft/quote booking:** `shipmentDraftRouter.js` + `shipmentQuoteRouter.js` uses actual runtime registry, pricing preflight, quote freshness, selected adapter, booking attempt state and reconciliation. This is the safe local mock workflow currently verified.
3. **Pickup creation:** `controller/createPickupRequestController.js` is a legacy provider-backed controller while `services/pickupRequestRouter.js` supports local lifecycle and adapter-based status sync. They have distinct behavior and should be explicitly mapped in route inventory and acceptance.
4. **Shipment/history models:** legacy `AppShipment` mixed data and newer draft/booked snapshots coexist. Backward compatibility is tested at route level but not manually checked against an approved copy of historical records.
5. **Operational views:** persisted NDR/RTO case lists coexist with dashboard shipment-grouped views that include derived observations. Current tests cover matching populations and read-only GET, but this distinction should remain explicit in product language.

## Manual acceptance checklist

Use a designated non-production account and `MOCK_LOCAL` only unless a separate provider test plan is approved. Do not use production records. Capture expected input/output and tester signoff for each item.

- [ ] Walk through all six booking sections; verify required fields, validation, saved-party reuse, multiple packages and draft reopen.
- [ ] Confirm direct Create Shipment is disabled when readiness is false/loading/error and enabled only in an approved test environment; verify backend guard independently.
- [ ] Use a client-approved complete tariff fixture; compare selling-price details, configuration errors, card assignment and immutable snapshot. Do not accept invented surcharge/GST examples.
- [ ] Save draft → compare mock quote → select quote → book mock; verify only local mock reference is created, no AWB/provider shipment exists, and booking snapshot separates partner quote from customer price.
- [ ] Confirm stale quote, ambiguous outcome, reconciliation, definitive rejection and duplicate click behavior with test fixtures. Verify that ambiguous outcomes never trigger another creation call.
- [ ] Exercise pickup create/reschedule/cancel/status and verify local versus carrier-backed labels and linked shipment population.
- [ ] Verify tracking timeline, webhook test authenticity, mapped/unknown statuses, and any available provider-confirmed status examples. Keep OOD unaccepted until mapping evidence is approved.
- [ ] Compare dashboard counts to filtered shipment/NDR/RTO/pickup lists over date boundaries; include duplicate NDR/RTO events, Pending AWB, Active RTO, Delivered, In Transit and exceptions.
- [ ] Validate customer monthly invoice totals, tax basis, payment allocations/outstanding and duplicate requests against finance-approved sample statements.
- [ ] Open CSV/XLSX/PDF exports in target office/PDF tools; compare filters, totals, currencies, provisional/unavailable labeling and empty result behavior.
- [ ] Verify search by AWB/customer/mobile/pincode, pagination, invalid/empty input, result navigation and cross-owner isolation.
- [ ] Review audit entries and request logs for actor/owner/correlation, safe fields and absence of secrets; verify log sink access and retention.
- [ ] Obtain RBAC role matrix approval before activation; test least privilege only after authorization.
- [ ] Infrastructure operator demonstrates completed backup metadata/artifact verification and restore into an isolated non-production database. Do not use production restore as a test.
- [ ] Run the direct provider acceptance plan only after credentials, sandbox account, API documentation and client approval; record provider request references and responses without secrets.

## Client decisions required

1. Customer identity, walk-in model, required profile/address/GST fields, credit terms/limits, outstanding source, and customer/rate-card archival/version policy.
2. Authoritative pincode-zone mapping; weight units, volumetric divisor, aggregation/rounding, slab edges and additional-weight increment/charge.
3. Fuel/COD/other surcharge bases/order; GST treatment/rates/taxable components/rounding; finance formulas for revenue, margin and provisional costs.
4. Quote expiry and “total partner cost” definition; treatment of partial quotes, missing ETA, serviceability, and historical delivery performance.
5. RBAC role/permission matrix and activation approval.
6. Audit retention, log retention, PII/search policy and notification audience/channel/consent.
7. Pickup pending lifecycle definition and policy for local versus provider-confirmed pickup operations.

## External provider and infrastructure dependencies

- Delhivery credentials, current API specifications, sandbox account, approved live integration flag, provider status examples/mappings, webhook signing/verification details, quote/ETA/serviceability support, pickup capabilities, AWB-later/reconciliation semantics, and final cost/invoice data.
- Any additional courier partners: API docs, credentials, test accounts, capabilities and onboarding acceptance.
- MongoDB hosting/provider identity, automated snapshot capability, backup storage/encryption/retention, operator secret management, RPO/RTO and isolated restore target.
- Production log/monitoring sink, alerting and access/retention policy.
- Optional cross-instance retry scheduling/leases if operations require background jobs; current retry helper is request-scoped/in-process.

## Requirements outside the SRD (tracked separately)

These are project/context controls or implementation choices, not represented here as additional SRD acceptance criteria:

- Local-only diagnostic endpoint that exposes safe mock configuration fields.
- Authenticated `/api/config/direct-booking` readiness boolean and frontend fail-closed gating.
- `MOCK_LOCAL` adapter and `courier_testing` safeguards/test reference conventions.
- Preserve existing `TEST-DRAFT-001`, do not book the test draft, and do not activate Delhivery/RBAC absent authorization.
- Batch-specific report/export formats and any technical choice of Node test runner, XLSX/PDF libraries, correlation header shape, or retry backoff constants where SRD does not prescribe them.

## Prioritized remaining work

1. **Resolve blockers before financial/provider acceptance:** approve rate, weight, surcharge, GST and invoice rules; approve customer/billing semantics; approve quote expiry/cost definitions.
2. **Close test regression:** update the `App.test.js` direct-booking mock to explicitly provide `directBookingEnabled: true` when exercising legacy behavior; add/retain false/loading/failure UI cases. Do this as a separate implementation task.
3. **Provider acceptance staging:** obtain current Delhivery docs and sandbox/credentials, validate status mappings including OOD, quotes, ETA/serviceability, booking/AWB/reconciliation, pickup, tracking, NDR/RTO and final costs. Add another provider only with approved requirements and docs.
4. **Operational acceptance:** complete dashboard card/filter parity matrix and pickup/exception definitions; add notifications after policy decisions.
5. **Finance acceptance:** reconcile generated reports/exports, invoices, payments and final-cost workflows to client-approved statements and actual provider settlement evidence.
6. **Security/operations closure:** approve/activate RBAC only after client role signoff; complete mutation audit inventory and sink retention review; have infrastructure owner establish and demonstrate backups/restores.
7. **Historical compatibility:** validate legacy shipment read/export and all new snapshots against an authorized isolated database copy; document retention, archive and migration policy.

## Final readiness assessment

**Not ready for production signoff or live courier activation.** It is suitable for continued local/mock acceptance of the workflows covered by passing tests, subject to approved pricing fixtures. Backend safe tests pass, but one frontend test remains inconsistent with fail-closed direct-booking readiness. Client pricing/tax and RBAC decisions are open; OOD and provider-specific operations lack verified mapping/capability evidence; database backup/restore remains an infrastructure-owner task. Manual acceptance and live-provider verification are not established by this report. No production data, booking, invoice, payment, provider API, deployment, or restore operation was used.
