#!/bin/bash
# Simplify and merge Philippine boundary TopoJSON files
#
# Input: Individual TopoJSON files from faeldon/philippines-json-maps
# Output: Combined and simplified TopoJSON files for regions, provinces, and LGUs
#
# Uses mapshaper for processing (installed via npm)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/source"
OUTPUT_DIR="$SCRIPT_DIR/../../public/geo"

# Use local mapshaper from node_modules
MAPSHAPER="npx mapshaper"

echo "Processing Philippine boundary files..."
echo ""

# Ensure output directory exists
mkdir -p "$OUTPUT_DIR"

# =============================================================================
# STEP 1: Create regions.topo.json (dissolve provinces into regions)
# =============================================================================
echo "=== Creating regions.topo.json ==="
echo "Merging province files and dissolving by region..."

# Merge all region files (which contain province boundaries)
$MAPSHAPER \
  "$SOURCE_DIR"/provdists-region-*.json combine-files \
  -merge-layers force \
  -dissolve adm1_psgc copy-fields=adm1_psgc \
  -rename-fields psgc=adm1_psgc \
  -each 'id = psgc' \
  -simplify 1% keep-shapes \
  -o "$OUTPUT_DIR/regions.topo.json" format=topojson target=*

echo "Regions file created."
echo ""

# =============================================================================
# STEP 2: Create provinces.topo.json (merge all province boundaries)
# =============================================================================
echo "=== Creating provinces.topo.json ==="
echo "Merging province boundaries..."

$MAPSHAPER \
  "$SOURCE_DIR"/provdists-region-*.json combine-files \
  -merge-layers force \
  -rename-fields psgc=adm2_psgc,region_psgc=adm1_psgc,name=adm2_en \
  -each 'id = psgc' \
  -simplify 0.5% keep-shapes \
  -o "$OUTPUT_DIR/provinces.topo.json" format=topojson target=*

echo "Provinces file created."
echo ""

# =============================================================================
# STEP 3: Create lgus.topo.json (merge all municipality/city boundaries)
# =============================================================================
echo "=== Creating lgus.topo.json ==="
echo "Merging LGU boundaries..."

$MAPSHAPER \
  "$SOURCE_DIR"/municities-provdist-*.json combine-files \
  -merge-layers force \
  -rename-fields psgc=adm3_psgc,province_psgc=adm2_psgc,name=adm3_en \
  -each 'id = psgc' \
  -simplify 0.1% keep-shapes \
  -o "$OUTPUT_DIR/lgus.topo.json" format=topojson target=*

echo "LGUs file created."
echo ""

# =============================================================================
# Verification
# =============================================================================
echo "=== Output File Sizes ==="
ls -lh "$OUTPUT_DIR"/*.topo.json

echo ""
echo "=== Verifying total size < 2MB ==="
TOTAL=$(du -cb "$OUTPUT_DIR"/*.topo.json | tail -1 | cut -f1)
TOTAL_KB=$((TOTAL / 1024))

if [ "$TOTAL" -gt 2097152 ]; then
  echo "WARNING: Total size ${TOTAL_KB}KB exceeds 2MB target"
  echo "Consider more aggressive simplification percentages"
  exit 1
else
  echo "OK: Total size is ${TOTAL_KB}KB"
fi

echo ""
echo "=== Feature Counts ==="
for f in "$OUTPUT_DIR"/*.topo.json; do
  NAME=$(basename "$f")
  COUNT=$(python3 -c "
import json
with open('$f') as fp:
    data = json.load(fp)
    total = sum(len(obj.get('geometries', [])) for obj in data.get('objects', {}).values())
    print(total)
")
  echo "$NAME: $COUNT features"
done

echo ""
echo "Processing complete!"
