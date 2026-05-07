// cargar-cat-entidades.js

const fs = require('fs');
const path = require('path');
const https = require('https');
const envPath = path.join('C:\\ExpedienteCheck\\expediente-check-backend', '.env');
console.log('Buscando .env en:', envPath);
console.log('Existe .env:', fs.existsSync(envPath));
const envVars = {};
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...val] = line.trim().split('=');
    if (key) envVars[key] = val.join('=');
  });
}
const SUPABASE_KEY = envVars['SUPABASE_SERVICE_KEY'];
console.log('Key cargada:', SUPABASE_KEY ? 'OK' : 'FALLA');

const API_URL = 'https://api.datosabiertos.mef.gob.pe/DatosAbiertos/v1/datastore_search_sql';
const RESOURCE_ID = '49d960a8-54cf-4a45-8ebe-d8074ac88877';


(async () => {
function fetchPage(limit, offset) {
  return new Promise((resolve, reject) => {
    const sql = `SELECT * FROM "49d960a8-54cf-4a45-8ebe-d8074ac88877" WHERE CAST("MONTO_PIM" AS NUMERIC) > 0 LIMIT ${limit} OFFSET ${offset}`;
    const url = `https://api.datosabiertos.mef.gob.pe/DatosAbiertos/v1/datastore_search_sql?sql=${encodeURIComponent(sql)}`;
    console.log('Consultando:', url.substring(0, 120));
    const u = new URL(url);
    https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json',
        'Referer': 'https://datosabiertos.mef.gob.pe/',
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          let records = [];
          if (Array.isArray(json.records)) {
            records = json.records;
          } else if (json.result && Array.isArray(json.result.records)) {
            records = json.result.records;
          }
          if (records.length > 0) {
            resolve(records);
          } else {
            reject(new Error('No records in response'));
          }
        } catch (e) {
          console.log('PARSE ERROR:', e.message);
        }
      });
    }).on('error', reject);
  });
}

  function supabaseUpsert(rows) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(rows);
      const req = https.request({
        hostname: 'xrbyvwliffdvfdmshaix.supabase.co',
        path: '/rest/v1/cat_entidades?on_conflict=cui,ejecutora',
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

  function mapRow(row) {
    return {
      cui: row.PRODUCTO_PROYECTO,
      nombre_proyecto: row.PRODUCTO_PROYECTO_NOMBRE,
      pliego: row.EJECUTORA, // usamos ejecutora como pliego
      pliego_nombre: row.EJECUTORA_NOMBRE,
      ejecutora: row.SEC_EJEC,
      ejecutora_nombre: row.EJECUTORA_NOMBRE,
      departamento_nombre: row.DEPARTAMENTO_EJECUTORA_NOMBRE,
      provincia_nombre: row.PROVINCIA_EJECUTORA_NOMBRE,
      distrito_nombre: row.DISTRITO_EJECUTORA_NOMBRE,
      nivel_gobierno: row.NIVEL_GOBIERNO,
      nivel_gobierno_nombre: row.NIVEL_GOBIERNO_NOMBRE,
      ano_eje: row.ANO_EJE
    };
  }

  (async () => {
    const PAGE_SIZE = 500;
    let offset = 0;
    let totalInserted = 0;
    let page = 1;
    while (true) {
      try {
        console.log(`\n--- Página ${page} (offset ${offset}) ---`);
        const records = await fetchPage(PAGE_SIZE, offset);
        if (records.length === 0) {
          console.log('Sin más registros. Carga completa.');
          break;
        }
        const rawMapped = records.map(mapRow);
        // Deduplicar por (cui, ejecutora) — conservar último valor
        const seen = new Map();
        rawMapped.forEach(r => seen.set(`${r.cui}|${r.ejecutora}`, r));
        const mapped = Array.from(seen.values());
        if (mapped.length < rawMapped.length) console.log(`  Duplicados eliminados: ${rawMapped.length - mapped.length}`);
        const inserted = await supabaseUpsert(mapped);
        totalInserted += inserted;
        console.log(`Página ${page}: ${inserted} registros. Total acumulado: ${totalInserted}`);
        if (records.length < PAGE_SIZE) {
          console.log('Última página alcanzada.');
          break;
        }
        offset += PAGE_SIZE;
        page++;
      } catch (e) {
        console.error(`Error en página ${page}:`, e.message);
        break;
      }
    }
    console.log(`\n=== CARGA COMPLETA: ${totalInserted} registros insertados/actualizados en Supabase ===`);
  })();
})();
