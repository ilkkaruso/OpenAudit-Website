#!/bin/bash
# Download high-resolution province boundaries from Faeldon's repo
# and merge into a single TopoJSON file

set -e

REPO_URL="https://raw.githubusercontent.com/faeldon/philippines-json-maps/master/2023/topojson/regions/hires"
GEO_DIR="/home/lesh/source/OpenAuditWebsite/public/geo"
TEMP_DIR="/tmp/ph-regions"

mkdir -p "$TEMP_DIR"

# Region codes (all 17 regions)
REGIONS=(
    "100000000"
    "200000000"
    "300000000"
    "400000000"
    "500000000"
    "600000000"
    "700000000"
    "800000000"
    "900000000"
    "1000000000"
    "1100000000"
    "1200000000"
    "1300000000"
    "1400000000"
    "1600000000"
    "1700000000"
    "1900000000"
)

echo "Downloading high-resolution province files..."
for code in "${REGIONS[@]}"; do
    file="provdists-region-${code}.topo.0.1.json"
    url="${REPO_URL}/${file}"
    echo "  Downloading ${file}..."
    curl -sL "$url" -o "${TEMP_DIR}/${file}"
done

echo "Files downloaded to ${TEMP_DIR}"
ls -la "${TEMP_DIR}"
