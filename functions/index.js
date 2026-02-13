const { bootstrapGoogleUser } = require("./src/bootstrapGoogleUser");
const { crearEmpleado } = require("./src/crearEmpleado");
const { syncProducts } = require("./src/syncProducts");
const { deleteProductByCode } = require("./src/deleteProductByCode");
const { createSale } = require("./src/createSale");
const { syncSales } = require("./src/syncSales");
const { closeCashbox } = require("./src/closeCashbox");

exports.bootstrapGoogleUser = bootstrapGoogleUser;
exports.crearEmpleado = crearEmpleado;
exports.syncProducts = syncProducts;
exports.deleteProductByCode = deleteProductByCode;
exports.createSale = createSale;
exports.syncSales = syncSales;
exports.closeCashbox = closeCashbox;
