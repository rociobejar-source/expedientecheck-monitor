// ============================================================
// SYNC TACNA v2 — SSI (por CUI) + Infobras → Supabase
// ============================================================

const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL          || 'https://xrbyvwliffdvfdmshaix.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SYNC_KEY      || process.env.SUPABASE_SERVICE_KEY;

// UUID de MPT Tacna en tabla entidades (no cambiar)
const ENTIDAD_ID_MPT = '5a275298-ba03-4f07-8616-64c283a9e27f';

// Lista exacta de inversiones MPT Tacna 2026 — fuente: Consulta Amigable MEF
const CUIS_TACNA = [
  "2677250","2566133","2223682","2611091","2666685","2235676","2675711",
  "2591893","2663682","2653253","2671035","2656537","2595263","2604965",
  "2104564","2016766","2472979","2677379","2677382","2677386","2677381",
  "2677380","2677383","2677385","2661375","2656631","2673119","2672489",
  "2673062","2673064","2349852","2680009","2673061","2672490","2672639",
  "2711892","2673063","2655185","2672496","2672486","2672491","2673118",
  "2672494","2711079","2663667","2671946","2671947","2624014","2607388",
  "2550409","2607379","2637784","2678225","2677099","2141758","2181122",
  "2552641"
];

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

// ── DEVENGADO 2026 — usa DEV_ANIO1 del endpoint traeDevengSSI ─
async function fetchDevengPIM(cui, tieneF12b = true) {
  const endpoint = tieneF12b
    ? 'https://ofi5.mef.gob.pe/invierteWS/Ssi/traeDevengPIM'
    : 'https://ofi5.mef.gob.pe/invierteWS/Ssi/traeDevengSSI';
  try {
    const arr = await httpPost(endpoint, { id: cui, tipo: 'FINAN' });
    const obj = Array.isArray(arr) ? arr[0] : arr;
    if (!obj) return {};

    // DEV_ANIO1 = devengado del año vigente (2026)
    // MTO_DEVEN = devengado acumulado histórico
    // traeDevengPIM devuelve array — sumar MTO_DEVEN y DEV_ANIO1 de todas las filas
    const rows = Array.isArray(arr) ? arr : [arr];
    const totalDev     = rows.reduce((s, r) => s + (parseFloat(r.MTO_DEVEN) || 0), 0);
    const totalDev2026 = rows.reduce((s, r) => s + (parseFloat(r.DEV_ANIO1) || 0), 0);
    const pim          = rows.length > 0 ? num(rows[0].MTO_PIM) : null;
    return {
      pim_ano_vigente:  pim,
      dev_acumulado:    totalDev > 0 ? totalDev : null,
      devengado_2026:   totalDev2026 > 0 ? totalDev2026 : null,
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
      devengado_2026:         pim.devengado_2026 ?? null,   // ← NUEVO
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
      entidad_id:             ENTIDAD_ID_MPT
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
    + '?nombre=municipalidad%20provincial%20de%20tacna'
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
      entidad_id:             ENTIDAD_ID_MPT
    });
  });
  const rows = Array.from(rowMap.values());
  await supabaseUpsert('infobras_obras', rows, 'entidad_id,cui');
  log(`  ✓ Infobras: ${rows.length} obras sincronizadas`);
}

async function main() {
  log('═══════════════════════════════════════════');
  log('  SYNC TACNA v2 — SSI por CUI + Infobras');
  log('═══════════════════════════════════════════');
  const cuis = CUIS_TACNA;
  log(`  Proyectos a sincronizar: ${cuis.length}`);
  try { await syncSSI(cuis); } catch (e) { log('✗ ERROR SSI: ' + e.message); }
  try { await syncInfobras(); } catch (e) { log('✗ ERROR Infobras: ' + e.message); }
  log('═══════════════════════════════════════════');
  log('  SYNC COMPLETADO');
  log('═══════════════════════════════════════════');
}

main();
