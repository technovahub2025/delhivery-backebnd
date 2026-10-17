require("dotenv").config({ quiet: true });
const jwt = require("jsonwebtoken");

console.log("Open DeliveryHub in Chrome and use DevTools Console.");
console.log("Run this there to inspect only the user ID claim:");
console.log("JSON.parse(atob(JSON.parse(sessionStorage.getItem('delhivery:session:v1:http://localhost:3000/api')).token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).id");
