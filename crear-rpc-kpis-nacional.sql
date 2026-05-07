-- RPC: get_kpis_nacional
-- KPIs agregados de ejecucion_nacional con filtros opcionales.

-- 1. Agregar columna nivel_gobierno si no existe
ALTER TABLE ejecucion_nacional
  ADD COLUMN IF NOT EXISTS nivel_gobierno TEXT;

-- 2. Poblar desde cat_entidades
UPDATE ejecucion_nacional en
SET nivel_gobierno = ce.nivel_gobierno
FROM cat_entidades ce
WHERE en.cui::TEXT = ce.cui::TEXT
  AND en.ejecutora::TEXT = ce.ejecutora::TEXT
  AND ce.nivel_gobierno IS NOT NULL;

-- 3. Crear funcion
CREATE OR REPLACE FUNCTION get_kpis_nacional(
  p_nivel        TEXT DEFAULT NULL,
  p_departamento TEXT DEFAULT NULL,
  p_provincia    TEXT DEFAULT NULL,
  p_ejecutora    TEXT DEFAULT NULL
)
RETURNS JSON AS $$
SELECT json_build_object(
  'total',           COUNT(*),
  'pim_total',       COALESCE(SUM(pim), 0),
  'devengado_total', COALESCE(SUM(devengado), 0),
  'rojos',           COUNT(*) FILTER (WHERE alerta = 'rojo'),
  'amarillos',       COUNT(*) FILTER (WHERE alerta = 'amarillo'),
  'verdes',          COUNT(*) FILTER (WHERE alerta = 'verde'),
  'sin_datos',       COUNT(*) FILTER (WHERE alerta = 'sin_datos' OR alerta IS NULL)
)
FROM ejecucion_nacional
WHERE pim > 0
  AND (p_nivel        IS NULL OR nivel_gobierno      = p_nivel)
  AND (p_departamento IS NULL OR departamento_nombre = p_departamento)
  AND (p_provincia    IS NULL OR provincia_nombre    = p_provincia)
  AND (p_ejecutora    IS NULL OR ejecutora::TEXT     = p_ejecutora)
$$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION get_kpis_nacional(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;