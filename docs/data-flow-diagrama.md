# Diagrama de flujo de datos (kioscoStock)

Este grafico resume como se mueven los datos entre UI, IndexedDB y Firebase.

```mermaid
flowchart TD
  U[Usuario en panel.html] --> UI[Eventos UI panel.js]
  UI --> P[Logica de productos products.js]
  P --> DB[(IndexedDB<br/>db.js)]
  P --> SYNC[syncProductToFirestore<br/>firebase_sync.js]
  SYNC --> FS[(Firestore<br/>coleccion productos)]

  UI --> V[Logica de ventas sales.js]
  V --> DB
  V --> SS[syncSaleToFirestore<br/>firebase_sync.js]
  SS --> FSV[(Firestore<br/>ventas y ventaItems)]

  UI --> C[Logica de caja cash.js]
  C --> DB
  C --> SC[syncCashClosureToFirestore<br/>firebase_sync.js]
  SC --> FSC[(Firestore<br/>cierres)]

  A[Auth auth.js] --> FA[Firebase Auth]
  FA --> A
  A --> DB
  A --> FU[syncUserToFirestore / syncLoginEventToFirestore]
  FU --> FSU[(Firestore<br/>usuarios y sesiones)]

  DB --> L[Lecturas locales para UI]
  FS -. sincronizacion best-effort .-> L
```

## Notas clave

- Para productos, primero se guarda en IndexedDB (`putProduct`) y luego se intenta sincronizar a Firestore.
- Si falla Firebase, el dato local queda guardado (`safeSync` captura error y devuelve `false`).
- Actualmente no hay un "pull" automatico de productos desde Firestore hacia IndexedDB en el frontend.

