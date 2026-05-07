// sync-nacional.js
// Lee cat_entidades de Supabase, consulta SSI MEF y actualiza ejecucion_nacional

const https = require('https');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://xrbyvwliffdvfdmshaix.supabase.co';

// CUIs genéricos del MEF: tipos de obra/programa con cientos de ejecutoras
// que inflan el PIM total — no son proyectos individuales rastreables
const NOMBRES_GENERICOS = new Set([
  'ESTUDIOS DE PRE-INVERSION',
  'FORTALECIMIENTO INSTITUCIONAL',
  'INICIATIVA A LA COMPETITIVIDAD',
  'CONCESIONES VIALES',
  'LIQUIDACION DE OBRAS',
  'OPERACION Y MANTENIMIENTO',
  'CONSTRUCCION DE PISTAS Y VEREDAS',
  'MEJORAMIENTO DE CENTROS EDUCATIVOS',
  'MEJORAMIENTO DE SISTEMA DE ABASTECIMIENTO DE AGUA POTABLE Y DESAGUE',
  'APOYO A LA PRODUCCION AGROPECUARIA',
  'MEJORAMIENTO DE SISTEMA DE RIEGO',
  'CONSTRUCCION DE LOCALES COMUNALES',
  'GESTION DE PROYECTOS',
  'CONCESIONES FERROVIARIAS',
  'CONCESIONES AEROPORTUARIAS',
  'CONCESIONES EN TELECOMUNICACIONES',
  'CONCESIONES PORTUARIAS',
});
const envVars = {};
try {
  const envPath = require('path').join('C:\\ExpedienteCheck\\expediente-check-backend', '.env');
  require('fs').readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.trim().split('=');
    if (k) envVars[k] = v.join('=');
  });
} catch(e) { console.error('No se pudo leer .env:', e.message); }
const SUPABASE_KEY = envVars['SUPABASE_SERVICE_KEY'];

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

async function supabaseFetchCatEntidades() {
  // Paginación para traer todos los registros
  const pageSize = 1000;
  let offset = 0;
  let allRows = [];
  while (true) {
    const rows = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'xrbyvwliffdvfdmshaix.supabase.co',
        path: `/rest/v1/cat_entidades?select=cui,ejecutora,ejecutora_nombre,pliego,pliego_nombre,departamento_nombre,provincia_nombre,nombre_proyecto,nivel_gobierno,nivel_gobierno_nombre&limit=${pageSize}&offset=${offset}`,

        method: 'GET',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); }
          catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
        });
      });
      req.on('error', reject);
      req.end();
    });
    if (!rows.length) break;
    allRows = allRows.concat(rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return allRows;
}

async function supabaseFetchInversionesNuevos(cuiSetExistentes) {
  // Trae inversiones con PIM > 0 que NO están en cat_entidades
  const pageSize = 1000;
  let offset = 0;
  let allRows = [];
  while (true) {
    const rows = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'xrbyvwliffdvfdmshaix.supabase.co',
        path: `/rest/v1/inversiones?select=CODIGO_UNICO,SEC_EJEC,NOMBRE_UEI,NOMBRE_INVERSION&PIM_ANIO_ACTUAL=gt.0&CODIGO_UNICO=not.is.null&limit=${pageSize}&offset=${offset}`,
        method: 'GET',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); }
          catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
        });
      });
      req.on('error', reject);
      req.end();
    });
    if (!Array.isArray(rows) || rows.length === 0) break;
    allRows = allRows.concat(rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  return allRows
    .filter(r => r.CODIGO_UNICO && !cuiSetExistentes.has(String(r.CODIGO_UNICO)))
    .map(r => ({
      cui: String(r.CODIGO_UNICO),
      ejecutora: r.SEC_EJEC || null,
      ejecutora_nombre: r.NOMBRE_UEI || null,
      nombre_proyecto: r.NOMBRE_INVERSION || null,
      pliego: null,
      pliego_nombre: null,
      departamento_nombre: null,
      provincia_nombre: null,
      nivel_gobierno: null,
      nivel_gobierno_nombre: null
    }));
}

function supabaseUpsertEjecucion(rows) {
  // Claves canónicas — todas las filas deben tenerlas (null si faltan)
  const KEYS = [
    'pliego','pliego_nombre','ejecutora','ejecutora_nombre','cui','nombre_proyecto',
    'departamento_nombre','provincia_nombre','nivel_gobierno','nivel_gobierno_nombre',
    'pim','devengado','avance_fisico','avance_financiero','alerta',
    'contratista','estado','costo_actualizado','monto_por_ejecutar','updated_at'
  ];
  const normalized = rows.map(r => {
    const obj = {};
    KEYS.forEach(k => { obj[k] = r[k] !== undefined ? r[k] : null; });
    return obj;
  });

  const batchSize = 500;
  return (async () => {
    for (let i = 0; i < normalized.length; i += batchSize) {
      const batch = normalized.slice(i, i + batchSize);
      await new Promise((resolve, reject) => {
        const body = JSON.stringify(batch);
        const req = https.request({
          hostname: 'xrbyvwliffdvfdmshaix.supabase.co',
          path: '/rest/v1/ejecucion_nacional?on_conflict=cui,ejecutora',
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
            ? resolve(batch.length)
            : reject(new Error(`Supabase ${res.statusCode}: ${d}`))
          );
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
    }
    return rows.length;
  })();
}

function num(val) {
  if (val === null || val === undefined) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

async function fetchSSI(cui) {
  // Consulta SSI MEF para datos de avance, estado, costo, etc. (basado en sync-tacna-v2.js)
  try {
    const arr = await httpPost(
      'https://ofi5.mef.gob.pe/invierteWS/Ssi/traeInfSeguimF12B',
      { id: cui, anio: '2026' }
    );
    const d = Array.isArray(arr) ? arr[0] : arr;
    if (!d) return {};
    return {
      avance_fisico: num(d.PORC_AVANCE_FIS),
      avance_financiero: num(d.PORC_AVANCE_EJEC),
      costo_actualizado: num(d.COSTO_ACTUALIZADO),
      alerta: d.DES_ALERTAS || null,
      contratista: d.MODAL_EJEC || null,
      estado: d.ESTADO || null,
    };
  } catch (e) {
    return {};
  }
}

async function fetchDevengPIM(cui) {
  try {
    const arr = await httpPost('https://ofi5.mef.gob.pe/invierteWS/Ssi/traeDevengPIM', { id: cui, anio: '2026' });
    const rows = Array.isArray(arr) ? arr : [arr];
    // DEV_ANO_VIGENTE: devengado del año vigente (2026) por fila
    // MTO_DEVEN: devengado histórico acumulado por fila
    const devengado_2026 = rows.reduce((s, r) => s + (parseFloat(r.DEV_ANO_VIGENTE) || 0), 0);
    const devengado_historico = rows.reduce((s, r) => s + (parseFloat(r.MTO_DEVEN) || 0), 0);
    const pim = rows.reduce((s, r) => s + (parseFloat(r.MTO_PIM) || 0), 0);
    return {
      pim: pim > 0 ? pim : null,
      devengado: devengado_2026 > 0 ? devengado_2026 : (devengado_historico > 0 ? devengado_historico : null),
      devengado_2026: devengado_2026 > 0 ? devengado_2026 : null,
      devengado_historico: devengado_historico > 0 ? devengado_historico : null
    };
  } catch (e) {
    return {};
  }
}

async function main() {
  // FUENTE 1: cat_entidades
  const entidades = await supabaseFetchCatEntidades();
  const cuiSetCat = new Set(entidades.map(e => String(e.cui)));

  // FUENTE 2: inversiones con PIM > 0 no en cat_entidades
  const inversionesNuevas = await supabaseFetchInversionesNuevos(cuiSetCat);

  // Merge y deduplicar por (cui, ejecutora)
  const seenKey = new Set(entidades.map(e => `${e.cui}|${e.ejecutora}`));
  const merged = [...entidades];
  for (const r of inversionesNuevas) {
    const key = `${r.cui}|${r.ejecutora}`;
    if (!seenKey.has(key)) {
      seenKey.add(key);
      merged.push(r);
    }
  }

  const concurrency = 5;
  let idx = 0;
  let rowsBatch = [];
  let errores = 0;
  const alertaCounts = { rojo: 0, amarillo: 0, verde: 0, sin_datos: 0 };
  const total = merged.length;
  const startTime = Date.now();

  // 4. LOG A ARCHIVO
  const logDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
  const logFile = path.join(logDir, `sync-nacional-${new Date().toISOString().slice(0,10)}.txt`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  function log(msg) {
    const ts = new Date().toISOString();
    logStream.write(`[${ts}] ${msg}\n`);
    console.log(msg);
  }
  log(`--- INICIO SYNC NACIONAL ---`);
  log(`Fuente 1 (cat_entidades)     : ${entidades.length}`);
  log(`Fuente 2 (inversiones nuevas): ${inversionesNuevas.length}`);
  log(`Total merged (deduplicado)   : ${merged.length}`);

  async function processEntidad(entidad) {
    if (NOMBRES_GENERICOS.has(entidad.nombre_proyecto?.trim())) return;
    const cui = entidad.cui;
    const ejecutora = entidad.ejecutora;
    let ssi = {}, dev = {};
    try {
      ssi = await fetchSSI(cui);
      if (!ssi || Object.keys(ssi).length === 0) throw new Error('SSI vacío');
    } catch (e) {
      errores++;
      ssi = {};
    }
    try {
      dev = await fetchDevengPIM(cui);
      if (!dev || Object.keys(dev).length === 0) throw new Error('DevengPIM vacío');
    } catch (e) {
      errores++;
      dev = {};
    }
    const costo_actualizado = num(ssi.costo_actualizado);
    const devengado = num(dev.devengado);
    const avance_fisico = ssi.avance_fisico != null ? num(ssi.avance_fisico) : null;
    const avance_financiero = ssi.avance_financiero != null ? num(ssi.avance_financiero) : null;
    const monto_por_ejecutar = costo_actualizado !== null && devengado !== null ? costo_actualizado - devengado : null;

    // Alerta calculada localmente por brecha financiero vs físico
    let alerta;
    if (avance_financiero == null && avance_fisico == null) {
      alerta = 'sin_datos';
    } else {
      const brecha = avance_fisico != null
        ? avance_financiero - avance_fisico
        : avance_financiero;
      alerta = brecha == null ? 'sin_datos'
        : brecha > 20 ? 'rojo'
        : brecha > 5  ? 'amarillo'
        : 'verde';
    }

    rowsBatch.push({
      pliego: entidad.pliego,
      pliego_nombre: entidad.pliego_nombre,
      ejecutora,
      ejecutora_nombre: entidad.ejecutora_nombre,
      cui,
      nombre_proyecto: entidad.nombre_proyecto,
      departamento_nombre: entidad.departamento_nombre,
      provincia_nombre: entidad.provincia_nombre,
      nivel_gobierno: entidad.nivel_gobierno,
      nivel_gobierno_nombre: entidad.nivel_gobierno_nombre,
      pim: dev.pim,
      devengado,
      avance_fisico,
      avance_financiero,
      alerta,
      contratista: ssi.contratista,
      estado: ssi.estado,
      costo_actualizado,
      monto_por_ejecutar,
      updated_at: new Date().toISOString()
    });
    if (alerta) alertaCounts[alerta] = (alertaCounts[alerta] || 0) + 1;
    // 1. Race condition: copiar y limpiar antes de upsert
    if (rowsBatch.length >= 500) {
      const toUpsert = [...rowsBatch];
      rowsBatch = [];
      await supabaseUpsertEjecucion(toUpsert);
    }
  }

  try {
    while (idx < total) {
      const batch = merged.slice(idx, idx + concurrency);
      await Promise.all(batch.map(processEntidad));
      idx += concurrency;
      // 2. Pausa entre batches
      await new Promise(r => setTimeout(r, 300));
      // 3. Progreso cada 500
      if (idx % 500 < concurrency && idx > 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        log(`Procesados: ${idx}/${total} | Errores: ${errores} | Tiempo: ${elapsed}s | Rojos: ${alertaCounts.rojo} Amarillos: ${alertaCounts.amarillo} Verdes: ${alertaCounts.verde} Sin_datos: ${alertaCounts.sin_datos}`);
      }
    }
    if (rowsBatch.length) {
      await supabaseUpsertEjecucion(rowsBatch);
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(``);
    log(`========== RESUMEN SYNC NACIONAL ==========`);
    log(`Total procesados : ${total}`);
    log(`Errores SSI      : ${errores}`);
    log(`Alerta ROJO      : ${alertaCounts.rojo}`);
    log(`Alerta AMARILLO  : ${alertaCounts.amarillo}`);
    log(`Alerta VERDE     : ${alertaCounts.verde}`);
    log(`Sin datos        : ${alertaCounts.sin_datos}`);
    log(`Tiempo total     : ${elapsed}s`);
    log(`===========================================`);
    log(`--- FIN SYNC NACIONAL ---`);
    logStream.end();
  } catch (fatal) {
    log(`✗ ERROR FATAL: ${fatal && fatal.message ? fatal.message : fatal}`);
    logStream.end();
    throw fatal;
  }
}


main();

// Para programar en el Task Scheduler de Windows a las 4am:
// schtasks /create /tn "ExpedienteCheck-SyncNacional" \
//   /tr "node C:\ExpedienteCheck\sync-nacional.js" \
//   /sc daily /st 04:00 /ru SYSTEM /f
