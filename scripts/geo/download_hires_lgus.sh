#!/bin/bash
# Download high-resolution municipality boundaries from Faeldon's repo

set -e

REPO_URL="https://raw.githubusercontent.com/faeldon/philippines-json-maps/master/2023/topojson/provdists/hires"
TEMP_DIR="/tmp/ph-lgus-hires"

mkdir -p "$TEMP_DIR"

# Get the list of files from the API
echo "Fetching file list..."
FILES=$(curl -s "https://api.github.com/repos/faeldon/philippines-json-maps/contents/2023/topojson/provdists/hires" | grep -o '"name": "[^"]*municities[^"]*"' | cut -d'"' -f4)

echo "Downloading high-resolution LGU files..."
for file in $FILES; do
    echo "  $file"
    curl -sL "${REPO_URL}/${file}" -o "${TEMP_DIR}/${file}"
done

echo "Files downloaded to ${TEMP_DIR}"
ls -la "${TEMP_DIR}" | head -20
echo "..."
echo "Total files: $(ls -1 "${TEMP_DIR}" | wc -l)"
