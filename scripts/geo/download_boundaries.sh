#!/bin/bash
# Download Philippine boundary files from faeldon/philippines-json-maps
#
# Repository structure (2023 data with Dec 2023 PSGC codes):
# - regions/lowres/provdists-region-XXX.json: Contains province boundaries per region
# - provdists/lowres/municities-provdist-XXX.json: Contains LGU boundaries per province
#
# We download region-level files (which contain provinces), then merge/dissolve as needed.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/source"
OUTPUT_DIR="$SCRIPT_DIR/../../public/geo"

# Create directories
mkdir -p "$SOURCE_DIR"
mkdir -p "$OUTPUT_DIR"

BASE_URL="https://raw.githubusercontent.com/faeldon/philippines-json-maps/master/2023/topojson"

echo "Downloading Philippine boundary files (Dec 2023 PSGC)..."
echo ""

# Download all region files (these contain province boundaries which we'll aggregate to regions)
echo "=== Downloading Province Boundaries per Region ==="

# Get actual file list from GitHub API
FILES=$(curl -s "https://api.github.com/repos/faeldon/philippines-json-maps/contents/2023/topojson/regions/lowres" | \
  python3 -c "
import sys,json
data = json.load(sys.stdin)
for item in data:
  print(item['name'])
")

for FILE in $FILES; do
  URL="${BASE_URL}/regions/lowres/${FILE}"
  echo "Downloading: $FILE"
  curl -sL -o "$SOURCE_DIR/$FILE" "$URL"
done

echo ""
echo "=== Downloading Municipality/City Boundaries per Province ==="

# Get municities files (these are at province level - one file per province)
PROV_FILES=$(curl -s "https://api.github.com/repos/faeldon/philippines-json-maps/contents/2023/topojson/provdists/lowres" | \
  python3 -c "
import sys,json
data = json.load(sys.stdin)
for item in data:
  print(item['name'])
")

for FILE in $PROV_FILES; do
  URL="${BASE_URL}/provdists/lowres/${FILE}"
  echo "Downloading: $FILE"
  curl -sL -o "$SOURCE_DIR/$FILE" "$URL"
done

echo ""
echo "=== Download Summary ==="
echo "Province boundary files: $(ls -1 $SOURCE_DIR/provdists-region-*.json 2>/dev/null | wc -l)"
echo "LGU boundary files: $(ls -1 $SOURCE_DIR/municities-provdist-*.json 2>/dev/null | wc -l)"

# Verify downloads
REGION_COUNT=$(ls -1 $SOURCE_DIR/provdists-region-*.json 2>/dev/null | wc -l)
if [ "$REGION_COUNT" -lt 10 ]; then
  echo ""
  echo "ERROR: Expected at least 10 region files, got $REGION_COUNT"
  exit 1
fi

echo ""
echo "Download complete! Source files in: $SOURCE_DIR"
echo ""
echo "Files contain:"
echo "- provdists-region-*.json: Province boundaries (to be dissolved into regions or used as-is)"
echo "- municities-provdist-*.json: Municipality/City boundaries per province"
