# Cambios 2026-07-10 — Ranking de inversiones, optimización de PDF y exportación a Excel

Hechos originalmente sobre `main` (backend Supabase/Railway + frontend estático).

**Actualización 2026-07-10 (tarde) — backend portado a `refactor/arquitectura`:**
las secciones 1, 2 y 5 (ranking, caché y limpieza de CUIs fantasma) ya están
portadas al backend pg/Cloud Run. Detalle en "Estado del port" al final de
cada sección. Lo único que queda pendiente es la sección 4 (Excel) y 3 (PDF),
que viven enteramente en `index.html` y se portarán junto con el frontend
React.

Repos afectados: `expediente-check-backend` (`server.js` en `main` /
`src/` en `refactor/arquitectura`) y `expedientecheck-monitor` (`index.html`,
sin cambios en refactor todavía).

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

**Estado del port (refactor/arquitectura)**: ✅ backend portado. El filtro
`FILTRO_SOLO_INVERSION_SQL` quedó en `src/config/index.js` (constante única,
reutilizada por ranking y genéricos — ya no hardcodeada 2 veces). Pendiente
`obtenerRankingEntidad()` en el futuro frontend React.

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

**Estado del port (refactor/arquitectura)**: ✅ hecho. Nuevo
`src/services/ranking.service.js` (`obtenerRankingInversiones`,
`obtenerGenericosPliego`, ambas cachés) + `src/controllers/ranking.controller.js`
(`GET /api/ranking-inversiones`, `GET /api/genericos-pliego`), montado en
`app.js`. Usa `httpGet` de `src/lib/http.js` (con timeout de
`config.MEF.HTTP_TIMEOUT_MS`) en vez de `https` nativo sin timeout como en
`server.js` — mismo dato, más robusto ante un MEF colgado.

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

**Dónde portar**: función `dibujarResumenEjecutivo(st, d)` en `index.html`
(sección "Ranking de ejecución de inversiones" + el `y += kpiH + 4` que la
precede), y el `generarDiagnosticoPDF()` que ya no fuerza salto de página.

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

**Estado del port (refactor/arquitectura)**: pendiente — es 100% frontend
(`index.html`) + el endpoint de solo lectura ya portado en la sección 2. Se
retoma con el frontend React.

---

## 5. Limpieza de CUIs "fantasma" (Tacna y Coronel Portillo)

**Síntoma**: CUIs sin nombre ni estado apareciendo en la tabla/Excel/PDF con
el fallback `CUI <código>` (ej. 2016766 en Tacna: "INICIATIVA A LA
COMPETITIVIDAD", un producto de Programa Presupuestal, no un proyecto real
de Invierte.pe). Encontrados también ~15 casos iguales en Coronel Portillo.

**Causa raíz**: el filtro de descubrimiento de CUIs (patrón de 7 dígitos que
empieza en 2/3) puede matchear códigos "PRODUCTO" de Programas
Presupuestales que no son proyectos de inversión real. SSI-MEF no devuelve
`NOMBRE_INVERSION` para esos códigos, así que quedan en `ssi_inversiones`
con solo `codigo_unico`/`pim_ano_vigente` — el resto null.

**Fix en 3 capas**:
1. Filtro de visualización: si `nombre_obra` (Infobras) Y `nombre_inversion`
   (SSI) Y ambos estados son null → se descarta la fila (no se muestra).
2. Filtro de origen: en el sync SSI, si `!row.nombre_inversion` se descarta
   antes de escribir (antes solo se descartaba el caso puntual "NO
   REGISTRADO EN EL INVIERTE" con costo 0 — dejaba pasar estos fantasmas).
3. Limpieza puntual de datos: se identificaron y borraron 16 filas ya
   persistidas (15 Coronel Portillo + 1 Tacna). **Importante**: se excluyeron
   deliberadamente 2 CUIs de Tacna (2502585, 2643374) que también tienen
   `nombre_inversion` null en SSI pero SÍ tienen `nombre_obra`/`estado` reales
   en Infobras — son proyectos legítimos, no fantasmas (ya estaban en
   `config.CUIS_EXCLUIDOS_MANUAL` por otro motivo — ver nota en el archivo).

**Dónde portar**: filtro de visualización en la función que arma el listado
de obras (`GET /api/obras` en `server.js`), y el discard en `syncSSI()` de
cada sync municipal (`sync-tacna-v3.js`, `sync-coronel-portillo.js`,
`sync-miraflores.js`) — la condición pasa de un caso puntual a
`if (!row.nombre_inversion) descartar`.

**Estado del port (refactor/arquitectura)**: ✅ hecho.
- `src/services/obras.service.js` → `listarObras()`: agregado el mismo
  filtro (fila con `nombre_obra`/`nombre_inversion`/ambos estados null se
  descarta con `.filter(Boolean)` después del `.map()`).
- `src/sync/municipio.sync.js` → `syncSSI()`: descarte ampliado a
  `!row.nombre_inversion` (reemplaza la condición puntual vieja). Este sync
  unificado reemplaza a los 3 scripts viejos de `main`.
- Limpieza de datos: la base Cloud SQL se migró el 2026-07-09 desde un dump
  **anterior** a este cleanup (hecho el 2026-07-10 sobre Supabase/main), así
  que tenía las mismas 16 filas fantasma intactas. Verificado y confirmado
  con una query directa (18 filas con `nombre_inversion IS NULL`: 16
  fantasmas reales + las 2 legítimas de Tacna) y borradas las 16 vía Cloud
  SQL Auth Proxy. Verificación posterior: solo quedan las 2 legítimas.

---

## Notas para el refactor (backend pg + frontend React)

- ~~El resource ID del MEF y el patrón CUI de "solo inversión" están
  hardcodeados en 2 lugares~~ — **ya resuelto en el port**: extraídos a
  `config.MEF.RESOURCE_PRESUPUESTO` (ya existía) y `config.FILTRO_SOLO_INVERSION_SQL`
  (nuevo) en `src/config/index.js`; `ranking.service.js` es el único lugar
  que arma ambas queries SQL.
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
