const mongoose = require('mongoose');
const productSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 200 },
  sku: { type: String, required: true, trim: true, maxlength: 100 },
  category: { type: String, trim: true, maxlength: 120 },
  price: { type: Number, required: true, min: 0 },
  discount: { type: Number, min: 0, default: 0 },
  discountType: { type: String, enum: ['FIXED', 'PERCENTAGE'], default: 'FIXED' },
  taxType: { type: String, trim: true, maxlength: 80 },
  imageUrl: { type: String, trim: true, maxlength: 1000 },
}, { timestamps: true });
productSchema.index({ owner: 1, sku: 1 }, { unique: true });
productSchema.index({ owner: 1, name: 1 });
module.exports = mongoose.models.Product || mongoose.model('Product', productSchema);
