# Delhivery controllers

Each of the 15 handlers from the supplied code has its own file in `controller/`. Request parameters, upstream API paths, and responses are preserved.

## Configuration

Add these values to your existing `.env` using your Delhivery environment URL and token:

```dotenv
DELHIVERY_BASE_URL=https://staging-express.delhivery.com
DELHIVERY_API_TOKEN=your_delhivery_token
```

Keep your existing MongoDB and JWT settings. Start with `node server.js`.

## Routes

| Method | Local endpoint | Controller |
| --- | --- | --- |
| GET | /api/delhivery/pincode | [checkPincodeController.js](controller/checkPincodeController.js) |
| GET | /api/delhivery/pincode/heavy | [checkHeavyPincodeController.js](controller/checkHeavyPincodeController.js) |
| GET | /api/delhivery/expected-tat | [getExpectedTatController.js](controller/getExpectedTatController.js) |
| GET | /api/delhivery/waybills | [fetchWaybillController.js](controller/fetchWaybillController.js) |
| POST | /api/delhivery/shipments | [createShipmentController.js](controller/createShipmentController.js) |
| POST | /api/delhivery/shipments/update | [updateShipmentController.js](controller/updateShipmentController.js) |
| POST | /api/delhivery/shipments/cancel | [cancelShipmentController.js](controller/cancelShipmentController.js) |
| POST | /api/delhivery/shipments/ewaybill | [updateEwaybillController.js](controller/updateEwaybillController.js) |
| GET | /api/delhivery/shipments/track | [trackShipmentController.js](controller/trackShipmentController.js) |
| GET | /api/delhivery/shipping-cost | [calculateShippingCostController.js](controller/calculateShippingCostController.js) |
| GET | /api/delhivery/shipping-label | [generateShippingLabelController.js](controller/generateShippingLabelController.js) |
| POST | /api/delhivery/pickups | [createPickupRequestController.js](controller/createPickupRequestController.js) |
| POST | /api/delhivery/warehouses | [createWarehouseController.js](controller/createWarehouseController.js) |
| POST | /api/delhivery/warehouses/update | [updateWarehouseController.js](controller/updateWarehouseController.js) |
| GET | /api/delhivery/documents | [downloadDocumentController.js](controller/downloadDocumentController.js) |

GET handlers use `req.query`; POST handlers use `req.body`. For example: `GET /api/delhivery/pincode?pincode=110001`.

`route/delhiveryroutes.js` connects the controllers to Express. `services/delhiveryService.js` provides the shared Axios client; `utils/delhiveryError.js` handles API errors. The existing `controller/pincodecontroller.js` remains available, but the new routes use the handlers from the attachment.

These routes currently have no authentication middleware. Live Delhivery calls require valid account configuration and have not been verified.
