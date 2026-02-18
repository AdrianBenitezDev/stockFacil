const { bootstrapGoogleUser } = require("./src/bootstrapGoogleUser");
const { crearEmpleado } = require("./src/crearEmpleado");
const { deleteEmpleado } = require("./src/deleteEmpleado");
const { syncProducts } = require("./src/syncProducts");
const { deleteProductByCode } = require("./src/deleteProductByCode");
const { createSale } = require("./src/createSale");
const { syncSales } = require("./src/syncSales");
const { closeCashbox } = require("./src/closeCashbox");
const { registerEmployerProfile } = require("./src/registerEmployerProfile");
const { markEmployerEmailVerified } = require("./src/markEmployerEmailVerified");
const { sendEmployerVerificationEmail } = require("./src/sendEmployerVerificationEmail");
const {seedPlanes} = require("./src/seedPlanes");

exports.seedPlanes = seedPlanes;

exports.bootstrapGoogleUser = bootstrapGoogleUser;
exports.crearEmpleado = crearEmpleado;
exports.deleteEmpleado = deleteEmpleado;
exports.syncProducts = syncProducts;
exports.deleteProductByCode = deleteProductByCode;
exports.createSale = createSale;
exports.syncSales = syncSales;
exports.closeCashbox = closeCashbox;
exports.registerEmployerProfile = registerEmployerProfile;
exports.markEmployerEmailVerified = markEmployerEmailVerified;
exports.sendEmployerVerificationEmail = sendEmployerVerificationEmail;
