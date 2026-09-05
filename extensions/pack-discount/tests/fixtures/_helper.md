Fixtures de la Function de packs. Se ejecutan contra el Wasm REAL compilado
(`npm run build` en la extensión), no contra un mock.

`camp_abc` es el id de campaña de referencia: es el valor que el widget escribe
en la propiedad `_df_pack` de cada línea y el que la config lleva en
`campaignId`. Que coincidan es la frontera de seguridad del tipo.
