const { bootstrapGoogleUser } = require("./src/bootstrapGoogleUser");
const { crearEmpleado } = require("./src/crearEmpleado");
const { syncProducts } = require("./src/syncProducts");
const { deleteProductByCode } = require("./src/deleteProductByCode");

exports.bootstrapGoogleUser = bootstrapGoogleUser;
exports.crearEmpleado = crearEmpleado;
exports.syncProducts = syncProducts;
exports.deleteProductByCode = deleteProductByCode;
