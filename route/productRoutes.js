const express = require('express');
const requireSession = require('../utils/requireSession');
const Product = require('../model/product');
function createProductRoutes({ ProductModel = Product } = {}) {
  const router = express.Router(); router.use(requireSession);
  router.get('/', async (req, res) => {
    const q = String(req.query.q || '').trim();
    const filter = { owner: req.user.id };
    if (q) filter.$or = [{ name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { sku: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }];
    const products = await ProductModel.find(filter).sort({ name: 1 }).limit(25).lean();
    return res.json({ success: true, data: { products } });
  });
  router.post('/', async (req, res) => {
    const body = req.body || {};
    if (!String(body.name || '').trim() || !String(body.sku || '').trim() || !Number.isFinite(Number(body.price)) || Number(body.price) < 0) return res.status(400).json({ success: false, message: 'Product name, SKU and a valid non-negative price are required.' });
    try { const product = await ProductModel.create({ ...body, owner: req.user.id, price: Number(body.price), discount: Number(body.discount || 0) }); return res.status(201).json({ success: true, data: { product } }); }
    catch (error) { return res.status(error?.code === 11000 ? 409 : 400).json({ success: false, message: error?.code === 11000 ? 'That SKU already exists.' : 'Product could not be saved.' }); }
  });
  return router;
}
const router = createProductRoutes(); router.createProductRoutes = createProductRoutes; module.exports = router;
