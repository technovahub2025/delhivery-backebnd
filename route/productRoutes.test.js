const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { createProductRoutes } = require('./productRoutes');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const owner = '64b000000000000000000001';
function model() { class M { static rows=[]; static find(filter){ return { sort(){return this}, limit(){return this}, lean: async()=>M.rows.filter(r=>String(r.owner)===String(filter.owner) && (!filter.$or || filter.$or.some(x=>Object.values(x)[0].test(String(r.name)) || Object.values(x)[0].test(String(r.sku))))) }; } static async create(row){ if(M.rows.some(x=>x.owner===row.owner&&x.sku===row.sku)){const e=new Error();e.code=11000;throw e;} const saved={...row,_id:'p'+M.rows.length};M.rows.push(saved);return saved;} } return M; }
function request(app, method, path, body) { return new Promise((resolve,reject)=>{const s=app.listen(0,()=>{const port=s.address().port;const req=http.request({port,method,path,headers:{Authorization:'Bearer '+jwt.sign({id:owner,exp:Math.floor(Date.now()/1000)+300},process.env.JWT_SECRET),'Content-Type':'application/json'}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{s.close();resolve({status:res.statusCode,body:JSON.parse(text)});});});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();});});}
test('product creation/search is owner scoped and rejects duplicate SKU', async()=>{const Product=model();const app=express();app.use(express.json());app.use('/products',createProductRoutes({ProductModel:Product}));let r=await request(app,'POST','/products',{name:'Shirt',sku:'S-1',price:100});assert.equal(r.status,201);r=await request(app,'GET','/products?q=S-1');assert.equal(r.body.data.products.length,1);r=await request(app,'POST','/products',{name:'Other',sku:'S-1',price:20});assert.equal(r.status,409);});
