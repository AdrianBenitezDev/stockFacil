export const DB_NAME = "kioscoStockDB";
export const DB_VERSION = 3;

export const STORES = {
  users: "users",
  products: "products"
};

export const SESSION_KEY = "kioscoStockSession";
export const DEFAULT_KIOSCO_ID = "kiosco-demo-001";
export const PRODUCT_CATEGORIES = [
  "Bebidas",
  "Golosinas",
  "Snacks",
  "Cigarrillos",
  "Limpieza",
  "Otros"
];

export const SEED_USERS = [
  {
    id: "u-dueno-001",
    kioscoId: DEFAULT_KIOSCO_ID,
    username: "kike",
    password: "nike123",
    role: "dueno",
    displayName: "Dueno"
  },
  {
    id: "u-emp-001",
    kioscoId: DEFAULT_KIOSCO_ID,
    username: "empleado1",
    password: "empleado123",
    role: "empleado",
    displayName: "Empleado 1"
  },
  {
    id: "u-emp-002",
    kioscoId: DEFAULT_KIOSCO_ID,
    username: "empleado2",
    password: "empleado123",
    role: "empleado",
    displayName: "Empleado 2"
  }
];
