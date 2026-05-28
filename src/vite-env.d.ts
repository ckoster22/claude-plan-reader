/// <reference types="vite/client" />

// Brings in Vite's client ambient types, including the `?raw` import suffix
// (`import html from "../index.html?raw"` → string). Used by src/contract.test.ts
// to assert against the REAL index.html without pulling in @types/node.
