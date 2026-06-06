// ============================================================
// SYNC CORONEL PORTILLO v2 — SSI dinámico desde Infobras → Supabase
// Los CUIs se leen dinámicamente desde infobras_obras en Supabase
// ============================================================

const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL          || 'https://xrbyvwliffdvfdmshaix.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SYNC_KEY      || process.env.SUPABASE_SERVICE_KEY;

// UUID de MPCP Coronel Portillo en tabla entidades
const ENTIDAD_ID_MPCP = '7a3aed25-7e45-4afe-adcd-e3745de79dbd';

function log(msg) {
  const ts = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });
  console.log(`[${ts}] ${msg}`);
}

function num(val) {
  if (val === null || val === undefined) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function httpPost(url, formData) {
  return new Promise((resolve, reject) => {
    const body = Object.entries(formData)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0',
        'Origin': 'https://ssi.mef.gob.pe',
        'Referer': 'https://ssi.mef.gob.pe/'
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

function supabaseUpsert(table, rows, conflictCol = 'codigo_unico') {
  return new Promise((resolve, reject) => {
    if (!rows.length) return resolve(0);
    const body = JSON.stringify(rows);
    const req = https.request({
      hostname: 'xrbyvwliffdvfdmshaix.supabase.co',
      path: `/rest/v1/${table}?on_conflict=${conflictCol}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'resolution=merge-duplicates'
      }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => res.statusCode < 300
        ? resolve(rows.length)
        : reject(new Error(`Supabase ${res.statusCode}: ${d}`))
      );
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseDate(val) {
  if (!val) return null;
  const str = String(val).trim();

  // Formato /Date(timestamp)/
  const tsMatch = str.match(/\/Date\((\d+)\)\//);
  if (tsMatch) {
    const ms = parseInt(tsMatch[1]);
    if (ms <= 0) return null;
    const fecha = new Date(ms);
    if (fecha.getFullYear() < 2000) return null;
    return fecha.toISOString().split('T')[0];
  }

  // Formato dd/MM/yyyy o dd/MM/yyyy HH:mm:ss
  const dmyMatch = str.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch;
    return `${y}-${m}-${d}`;
  }

  return null;
}

async function fetchDevengPIM(cui, tieneF12b = true) {
  const endpoint = tieneF12b
    ? 'https://ofi5.mef.gob.pe/invierteWS/Ssi/traeDevengPIM'
    : 'https://ofi5.mef.gob.pe/invierteWS/Ssi/traeDevengSSI';
  try {
    const arr = await httpPost(endpoint, { id: cui, tipo: 'FINAN' });
    const rows = Array.isArray(arr) ? arr : [arr];
    const totalDev     = rows.reduce((s, r) => s + (parseFloat(r.MTO_DEVEN) || 0), 0);
    const totalDev2026 = rows.reduce((s, r) => s + (parseFloat(r.DEV_ANIO1) || 0), 0);
    const pim          = rows.length > 0 ? num(rows[0].MTO_PIM) : null;
    return {
      pim_ano_vigente: pim,
      dev_acumulado:   totalDev > 0 ? totalDev : null,
      devengado_2026:  totalDev2026 > 0 ? totalDev2026 : null,
    };
  } catch (e) {
    return {};
  }
}

async function fetchSSICui(cui) {
  try {
    const arr = await httpPost(
      'https://ofi5.mef.gob.pe/invierteWS/Ssi/traeInfSeguimF12B',
      { id: cui, tipo: 'SIAF' }
    );
    const d = Array.isArray(arr) ? arr[0] : arr;
    const tieneF12B = d && d.NOMBRE_INVERSION;

    let base = d;
    if (!tieneF12B) {
      try {
        const det = await httpPost(
          'https://ofi5.mef.gob.pe/invierteWS/Ssi/traeDetInvSSI',
          { id: cui, tipo: 'SIAF' }
        );
        if (det) base = Array.isArray(det) ? det[0] : det;
      } catch(e2) {}
    }

    if (!base || typeof base !== 'object') return null;

    const pim = await fetchDevengPIM(cui, tieneF12B);

    return {
      codigo_unico:           String(cui),
      nombre_inversion:       base.NOMBRE_INVERSION ?? null,
      entidad:                base.ENTIDAD ?? null,
      sector:                 base.SECTOR ?? null,
      funcion:                base.FUNCION ?? null,
      estado_inversion:       base.DES_ESTADO ?? base.ESTADO ?? null,
      tipo_inversion:         tieneF12B ? (base.TIPO_FORMATO ?? null) : (base.DES_TIPO_INV ?? null),
      modalidad_ejecucion:    base.MODAL_EJEC ?? null,
      nivel:                  base.NIVEL ?? null,
      avance_fisico:          num(base.PORC_AVANCE_FIS ?? base.AVAN_FISICO),
      porc_avance_fis:        num(base.PORC_AVANCE_FIS ?? base.AVAN_FISICO),
      fecha_inicio_ejecucion: parseDate(base.FEC_INI_EJEC ?? base.FEC_INI_EJ),
      fecha_fin_ejecucion:    parseDate(base.FEC_FIN_EJEC ?? base.FEC_FIN_EJ),
      pim_ano_vigente:        pim.pim_ano_vigente ?? num(base.PIM_ANO_VIGENTE),
      dev_ano_vigente:        pim.dev_ano_vigente ?? num(base.DEV_ANO_VIGENTE),
      devengado_2026:         pim.devengado_2026 ?? null,
      dev_acumulado:          pim.dev_acumulado ?? num(base.DEV_ACUMULADO),
      dev_acum_ant:           num(base.DEV_ACUM_ANT),
      costo_actualizado:      num(base.COSTO_ACTUALIZADO),
      mto_viable:             num(base.MTO_VIABLE),
      monto_prog_ano_mes_f12: num(base.MONTO_PROG_ANO_MES_F12),
      monto_actu_ano_mes_f12: num(base.MONTO_ACTU_ANO_MES_F12),
      es_cartera_priorizada:  num(base.ES_CARTERA_PRIORIZADA),
      ult_fec_decla_estim:    tieneF12B ? parseDate(base.FECHA_ULT_ACT_F12B) : null,
      tiene_f8:               base.TIENE_F8 ?? null,
      des_unidad_uei:         base.DES_UNIDAD_UEI ?? null,
      des_unidad_uf:          base.DES_UNIDAD_UF ?? null,
      ind_alertas_mef:        base.IND_ALERTAS ?? null,
      des_alert_ejec_mef:     base.DES_ALERT_EJEC ?? null,
      fuente:                 tieneF12B ? 'f12b' : 'ssi',
      fecha_actualizacion:    new Date().toISOString(),
      entidad_id:             ENTIDAD_ID_MPCP   // ← Coronel Portillo
    };
  } catch (e) {
    log(`  ⚠ Error CUI ${cui}: ${e.message}`);
    return null;
  }
}

async function syncSSI(cuis) {
  log(`▶ Iniciando sync SSI — ${cuis.length} proyectos...`);
  const rows = [];
  let ok = 0, errors = 0;

  for (let i = 0; i < cuis.length; i++) {
    const cui = cuis[i];
    const row = await fetchSSICui(cui);
    if (row) { rows.push(row); ok++; }
    else errors++;
    if (i % 10 === 9) await sleep(1000);
  }

  if (rows.length) {
    await supabaseUpsert('ssi_inversiones', rows, 'entidad_id,codigo_unico');
    log(`  ✓ SSI: ${ok} proyectos sincronizados (${errors} errores)`);
  }
}

async function syncInfobras() {
  log('▶ Iniciando sync Infobras...');
  const url = 'https://infobras.contraloria.gob.pe/InfobrasWeb/Mapa/MapaEstadistico/BusquedaSimple'
    + '?nombre=municipalidad%20provincial%20de%20coronel%20portillo'
    + '&codigo=&valor=&estado=&orderBy=en_ejecucion&pageNumber=1&pageSize=1000';

  const data = await httpGet(url);
  if (data.Code !== 0 || !data.Result) throw new Error('Infobras error: ' + JSON.stringify(data));

  const rowMap = new Map();
  data.Result.forEach(o => {
    const cui = o.CUI ?? null;
    if (!cui) return;
    rowMap.set(String(cui), {
      cui:                    String(cui),
      nombre_obra:            o.NombreObra ?? null,
      estado:                 o.Estado ?? null,
      ubicacion:              o.Ubicacion ?? null,
      codigo:                 o.Codigo ?? null,
      entidad_nombre:         o.EntidadNombre ?? null,
      contratista:            o.Contratista ?? null,
      monto:                  num(o.Monto),
      avance_fisico:          num(o.AvanceFisico),
      fecha_inicio_ejecucion: o.FechaInicioEjecucion ?? null,
      fecha_finalizacion:     o.FechaFinalizacion ?? null,
      departamento:           o.Departamento ?? null,
      provincia:              o.Provincia ?? null,
      distrito:               o.Distrito ?? null,
      modalidad_ejecucion:    o.ModalidadEjecucion ?? null,
      imagen:                 o.Imagen ?? null,
      fecha_actualizacion:    new Date().toISOString(),
      entidad_id:             ENTIDAD_ID_MPCP   // ← Coronel Portillo
    });
  });
  const rows = Array.from(rowMap.values());
  await supabaseUpsert('infobras_obras', rows, 'entidad_id,cui');
  log(`  ✓ Infobras: ${rows.length} obras sincronizadas`);
}

async function fetchCuisDesdeInfobras() {
  return new Promise((resolve, reject) => {
    const path = `/rest/v1/infobras_obras?select=cui&entidad_id=eq.${ENTIDAD_ID_MPCP}&limit=2000`;
    const req = https.request({
      hostname: 'xrbyvwliffdvfdmshaix.supabase.co',
      path,
      method: 'GET',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const rows = JSON.parse(d);
          const cuis = [...new Set(rows.map(r => r.cui).filter(Boolean))];
          resolve(cuis);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  log('═══════════════════════════════════════════');
  log('  SYNC CORONEL PORTILLO v2 — SSI dinámico + Infobras');
  log('═══════════════════════════════════════════');

  // 1. Sync Infobras primero (para tener los CUIs actualizados)
  try { await syncInfobras(); } catch (e) { log('✗ ERROR Infobras: ' + e.message); }

  // 2. Leer CUIs desde infobras_obras en Supabase
  log('▶ Leyendo CUIs desde infobras_obras...');
  const cuis = await fetchCuisDesdeInfobras();
  log(`  ${cuis.length} CUIs encontrados en infobras_obras`);

  // 3. Sync SSI para todos esos CUIs
  try { await syncSSI(cuis); } catch (e) { log('✗ ERROR SSI: ' + e.message); }

  log('═══════════════════════════════════════════');
  log('  SYNC COMPLETADO');
  log('═══════════════════════════════════════════');
}

main();
