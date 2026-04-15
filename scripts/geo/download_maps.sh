#!/bin/bash
# Download/prepare TopoJSON map files for OpenAudit Philippines
# Uses Faeldon's philippines-json-maps for country outline
# Uses existing project files for provinces and LGUs

set -e

REPO_URL="https://raw.githubusercontent.com/faeldon/philippines-json-maps/master/2023/topojson"
GEO_DIR="public/geo"

echo "Downloading country outline (low-res for fast loading)..."
curl -L "${REPO_URL}/country/lowres/country.topo.0.001.json" -o "${GEO_DIR}/ph-outline.topo.json"

# Copy existing project files to expected names if they don't exist
if [ ! -f "${GEO_DIR}/provinces-hires.topo.json" ] || [ -s "${GEO_DIR}/provinces-hires.topo.json" ]; then
  echo "Copying provinces.topo.json to provinces-hires.topo.json..."
  cp "${GEO_DIR}/provinces.topo.json" "${GEO_DIR}/provinces-hires.topo.json"
fi

if [ ! -f "${GEO_DIR}/municities-hires.topo.json" ] || [ -s "${GEO_DIR}/municities-hires.topo.json" ]; then
  echo "Copying lgus.topo.json to municities-hires.topo.json..."
  cp "${GEO_DIR}/lgus.topo.json" "${GEO_DIR}/municities-hires.topo.json"
fi

echo "Done! Files saved to ${GEO_DIR}/"
ls -lh ${GEO_DIR}/*.json
