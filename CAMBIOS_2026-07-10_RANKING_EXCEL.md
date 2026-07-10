# Cambios 2026-07-10 — Ranking de inversiones, optimización de PDF, exportación a Excel y limpieza de CUIs fantasma

Hechos sobre `main` (backend Supabase/Railway + frontend estático), **no** sobre
`refactor/arquitectura`. Este documento es la guía para portar la misma
funcionalidad cuando se retome ese refactor (backend pg/Identity en Cloud Run +
eventual frontend React).

Repos afectados: `expediente-check-backend` (`server.js`,
`sync-tacna-v3.js`, `sync-coronel-portillo.js`, `sync-miraflores.js`) y
`expedientecheck-monitor` (`index.html`).

---

## 1. Fix del ranking de ejecución (comparaba presupuesto global, no inversión)

**Síntoma**: el ranking mostraba 48% para una entidad cuyo dashboard (solo
inversión, vía `ssi_inversiones`) marcaba 18.5%.

**Causa raíz**: la query a Datos Abiertos MEF sumaba `MONTO_PIM`/`MONTO_DEVENGADO`
de **todo** el presupuesto (personal, bienes/servicios, deuda, inversión...),
sin filtrar por proyecto de inversión. El gasto corriente ejecuta mucho más
rápido que la inversión pública, así que el % salía inflado y no era
comparable con "Con seguimiento ExpedienteCheck".

**Fix**: filtro `PRODUCTO_PROYECTO` (mismo criterio que ya usaba
`sync-certificado-comprometido.js`: CUI de 7 dígitos que empieza en '2' o '3',
excluyendo prefijos '3000'/'3033'/'3999') aplicado a la query del ranking.
Validado con datos reales: Miraflores sin filtro = 47.98%, con filtro = 18.53%
(coincide exacto con el dashboard). También se validó que
`inversión + genéricos = presupuesto total del pliego` (31.2M + 308.9M ≈ 340.1M).

**Además**: se agregó el nivel **nacional** (antes solo prov+dept) — la query
pasó a ser nacional única (sin filtro de departamento), de la que se derivan
los 3 niveles filtrando client-side por prefijo de ubigeo (2 dígitos = depto,
4 dígitos = depto+prov). El código `EJECUTORA` del MEF **es el ubigeo** de la
municipalidad — así se evita el problema de homónimos (hay 4 "Miraflores").

**Dónde portar**: función `obtenerRankingEntidad(entidad)` en `index.html` +
endpoint `/api/ranking-inversiones` en `server.js` (ver sección 2, están
acoplados).

---

## 2. Optimización de tiempo — caché del ranking en el backend

**Síntoma**: cada generación de PDF disparaba una consulta en vivo al MEF que
escanea el dataset nacional (26-61s medido), aunque la consulta es SIEMPRE
la misma (mismo filtro, mismo año — solo cambia qué entidad es "la propia",
y eso se resuelve client-side).

**Fix**: nuevo endpoint `GET /api/ranking-inversiones` en `server.js` que
cachea el resultado en memoria del proceso por 6h (`RANKING_TTL_MS`). Si dos
requests llegan con la caché fría al mismo tiempo, comparten la misma
consulta en curso (`rankingInFlight`) en vez de duplicar el full-scan.
El frontend (`obtenerRankingEntidad` en `index.html`) ya no arma el SQL ni le
pega al proxy genérico `/api/proxy/datos-abiertos` — solo hace
`fetch(`${API}/api/ranking-inversiones`)`.

**Timeout**: 90s en el cliente (cubre el caso de caché fría, 26-61s
observado); con caché caliente responde en milisegundos.

**Dónde portar**: endpoint completo `/api/ranking-inversiones` +
`fetchRankingInversionesDesdeMef()` + `rankingCache`/`rankingInFlight` en
`server.js`. Es agnóstico de la capa de datos (pg vs Supabase) — no toca
ninguna tabla propia, solo cachea en memoria del proceso Node.

---

## 3. Rediseño del bloque de ranking en el PDF (`index.html`)

- 3 tarjetas en vez de 2 (Nacional / Departamento / Provincia), fuente
  reducida para que quepan.
- Reubicado: ahora va junto a los KPIs principales (al lado de "EJECUCIÓN
  DEL PIM"), no al final de la página.
- Se eliminó el salto de página forzado incondicional al final del resumen
  ejecutivo (antes: `pdfNewPage()` siempre, dejando espacio en blanco si el
  contenido era corto, o cortando secciones si no cabía). Ahora el contenido
  fluye natural; se agregó un guard (`pdfEnsureSpace(st, 24)`) antes del
  encabezado "Inversiones con alerta" para que nunca quede huérfano al pie
  de una hoja.
- **Marca de referencia en la barra** (agregado después, por observación de
  usuario): la barra de "TÚ" en cada tarjeta de ranking solo mostraba el
  llenado absoluto — no había forma visual de saber si estaba por encima o
  debajo del promedio del grupo, solo leyendo los números de abajo. Se
  extendió `pdfProgressBar(st, x, y, w, h, pct, trackColor, fillColor,
  markerPct, markerColor)` con 2 parámetros opcionales que dibujan una marca
  vertical en la posición del promedio sobre la barra.

**Dónde portar**: función `dibujarResumenEjecutivo(st, d)` en `index.html`
(sección "Ranking de ejecución de inversiones" + el `y += kpiH + 4` que la
precede), el `generarDiagnosticoPDF()` que ya no fuerza salto de página, y
`pdfProgressBar()` con los parámetros de marker.

---

## 4. Exportación a Excel (`index.html` + `server.js`)

**Botón nuevo** "Generar Excel" en el index (3 botones en total: PDF, Excel,
Actualizar datos). Al pulsarlo se abre un **modal flotante** (no un
checkbox aparte) preguntando si incluir "Solo inversiones (rápido)" o
"Inversiones + genéricos" — `preguntarIncluirGenericos()` devuelve una
Promise<boolean|null> (null = cancelado).

**Librería**: `ExcelJS` vía CDN (`exceljs@4.4.0/dist/exceljs.min.js`), NO
SheetJS — SheetJS community edition no soporta escribir estilos (colores,
bordes). Reemplaza el `<script>` de jsPDF que ya estaba (queda ambos, jsPDF
para el PDF, ExcelJS para el Excel).

**Hoja "Inversiones"** (siempre, costo cero — mismos datos ya cargados en
memoria que arman la tabla y el PDF): CUI, Nombre, UEI, Estado, Modalidad,
Contratista, Avance físico/financiero (%), PIM, Certificado, Comprometido,
Devengado, % Ejecución PIM, Costo actualizado, Devengado acumulado, Alertas,
fechas inicio/fin. Fila coloreada según nivel de alerta más alto (rojo claro
/ ámbar claro, mismo semáforo que la tabla y el PDF). Fila de TOTAL al final.

**Hoja "Genéricos"** (opcional, vía el modal): gasto corriente del pliego
FUERA de Invierte.pe. Requiere el endpoint nuevo `GET
/api/genericos-pliego?e=<slug>` en `server.js`:
- Resuelve `slug` → `ubigeo` vía tabla `entidades`.
- Consulta MEF filtrada por `EJECUTORA=<ubigeo>` y **excluyendo** las líneas
  de inversión (mismo filtro de la sección 1, pero envuelto en `NOT (...)`)
  para no duplicar lo que ya se ve en la hoja "Inversiones".
- Agrupa por `GENERICA_NOMBRE` + `PROGRAMA_PPTO_NOMBRE` (resumen ~10-30
  filas, no cientos de líneas crudas — se decidió así por legibilidad).
- Cacheado por ubigeo, 6h (`genericosCache`, `genericosInFlight`), mismo
  patrón que el ranking.
- Tiempo real medido: 22-50s (más rápido que el ranking nacional porque es
  una sola entidad, pero no instantáneo — por eso es opt-in vía el modal,
  no automático).

**Estilo**: encabezados con fondo de color (navy para Inversiones, dorado
para Genéricos — mismos tonos que `PDF_COLORS` del PDF), texto blanco
negrita, freeze panes en la fila de encabezado, formato de moneda
(`#,##0.00`) y porcentaje (`0.0"%"` — nótese que NO es el formato `%`
nativo de Excel, porque los valores ya están en escala 0-100, no 0-1),
bordes finos, fila de totales en negrita con borde superior.

**Dónde portar**: `preguntarIncluirGenericos()`, `EXCEL_COLORS`,
`estilizarHeader()`, `bordearFila()`, `generarExcelDiagnostico()` completo en
`index.html`, el modal HTML (`#modal-excel-overlay` y sus 3 botones), el
`<script>` de ExcelJS en el `<head>`, y el endpoint `/api/genericos-pliego`
completo en `server.js` (incluye `fetchGenericosDesdeMef`, que reutiliza
`RANKING_MEF_RESOURCE_ID` de la sección 2 — portar ambos juntos).

---

## 5. CUIs "fantasma" (genéricos que se colaban como inversiones)

**Síntoma**: en Tacna y Coronel Portillo aparecían CUIs sin nombre (fallback
`CUI <código>`) en tabla/PDF/Excel — reportado por la jefa de Rocío.

**Causa raíz**: el descubrimiento de CUIs (`sync-certificado-comprometido.js`,
patrón `PRODUCTO_PROYECTO` de 7 dígitos que empieza en '2'/'3') a veces
matchea un "producto" de un Programa Presupuestal (ej. CUI 2016766 =
"INICIATIVA A LA COMPETITIVIDAD" en Tacna) que NO es un proyecto real de
Invierte.pe. `TIPO_ACT_PROY_NOMBRE='PROYECTO'` en el MEF **no sirve** para
distinguirlos (ambos lo tienen) — la única señal confiable es que SSI-MEF
(invierte.pe) no devuelve `NOMBRE_INVERSION` para estos códigos.

**Fix de pantalla**: `/api/obras` en `server.js` ahora descarta filas donde
`nombre`/`estado` están vacíos en AMBAS fuentes (SSI + InfoObras).

**Fix de origen**: en `sync-tacna-v3.js`, `sync-coronel-portillo.js` y
`sync-miraflores.js`, el guard que antes solo descartaba
`estado_inversion === 'NO REGISTRADO EN EL INVIERTE'` con costo 0 ahora
descarta cualquier fila sin `nombre_inversion` — así no se vuelven a
insertar en futuros syncs.

**Limpieza puntual** (2026-07-10, ya ejecutada en prod): se borraron 16 filas
de `ssi_inversiones` — CUI 2016766 en Tacna, y 15 CUIs en Coronel Portillo
(2016766, 2021237, 2021280, 2021281, 2488840, 2507002, 2531223, 2637616,
2638729, 2711408, 2711804, 2728326, 2728793, 3043952, 3043977).
**Ojo**: los CUIs 2502585 y 2643374 de Tacna (en `CUIS_EXCLUIDOS_MANUAL` de
`sync-certificado-comprometido.js`) también tenían `nombre_inversion` nulo
en SSI, pero **SÍ son proyectos reales** — InfoObras tiene su nombre/estado
y se siguen mostrando bien en el monitor. No se borraron (verificado con una
consulta posterior: solo esos 2 quedan con `nombre_inversion` null en toda
la tabla, y ambos tienen respaldo de InfoObras).

**Dónde portar**: el guard `!row.nombre_inversion` en los 3 scripts de sync,
y el filtro de fila fantasma en `/api/obras`. Si el refactor reescribe estos
syncs, esta validación debe ir en el punto donde se decide si un CUI
descubierto entra o no a la tabla de inversiones — no en la capa de
presentación solamente, porque si no se repite el mismo problema.

---

## Notas para el refactor (backend pg + frontend React)

- El resource ID del MEF (`615644aa-ef73-4358-b4e0-0c20931632f3`) y el
  patrón CUI de "solo inversión" están **hardcodeados en 2 lugares** ahora
  (`fetchRankingInversionesDesdeMef` y `fetchGenericosDesdeMef` en
  `server.js`) — al portar, vale la pena extraerlos a una constante/función
  compartida (`FILTRO_SOLO_INVERSION`, `MEF_RESOURCE_ID`) en un módulo único,
  algo que en el frontend estático de hoy no se justificaba pero en el
  refactor con módulos ES sí.
- Las cachés (`rankingCache`, `genericosCache`) son en memoria del proceso
  Node — funcionan porque hoy hay una sola instancia (`min=max=1` en el plan
  de Cloud Run, o Railway sin réplicas). Si el refactor corre con más de una
  instancia/réplica, esta caché en memoria dejaría de ser consistente entre
  instancias y habría que moverla a Redis/Supabase/Cloud SQL.
- El endpoint `/api/genericos-pliego` resuelve `slug → ubigeo` contra la
  tabla `entidades` de Supabase — al portar a pg (Cloud SQL), es el mismo
  query, solo cambia el cliente de datos (pg pool en vez de `@supabase/supabase-js`).
- Todo lo del punto 4 (Excel) es 100% frontend + un endpoint de solo lectura
  — no depende de qué stack de auth/DB tenga el backend, así que portarlo es
  bajo riesgo.
- El fix de la sección 5 (`!row.nombre_inversion`) es puramente de
  validación en el pipeline de sync — no depende de Supabase vs pg, se porta
  tal cual al reescribir esos scripts contra Cloud SQL.
