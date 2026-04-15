#!/usr/bin/env python3
"""
Merge all regional province TopoJSONs into a single national file.
Also generates a PSGC mapping file to help match score data to geometries.
"""

import json
from pathlib import Path
import subprocess

TEMP_DIR = Path("/tmp/ph-regions")
OUTPUT_DIR = Path("/home/lesh/source/OpenAuditWebsite/public/geo")

def main():
    # Read all regional TopoJSON files and extract province geometries
    all_provinces = []

    for topo_file in sorted(TEMP_DIR.glob("provdists-region-*.topo.0.1.json")):
        print(f"Processing {topo_file.name}...")
        with open(topo_file, 'r', encoding='utf-8') as f:
            data = json.load(f)

        # Get the object name and extract geometries
        for obj_name, obj_data in data.get('objects', {}).items():
            for geom in obj_data.get('geometries', []):
                props = geom.get('properties', {})
                psgc = props.get('psgc') or props.get('PSGC') or props.get('id')
                name = props.get('name') or props.get('NAME')

                if psgc:
                    # Add region info from the filename for debugging
                    all_provinces.append({
                        'psgc': str(psgc),
                        'psgc_5digit': str(psgc)[:5],
                        'name': name,
                        'geo_level': props.get('geo_level', 'Prov'),
                        'region_psgc': props.get('region_psgc')
                    })

    print(f"\nFound {len(all_provinces)} province geometries")

    # Create PSGC mapping for score data matching
    psgc_mapping = {}
    for p in all_provinces:
        psgc_5 = p['psgc_5digit']
        psgc_mapping[psgc_5] = {
            'full_psgc': p['psgc'],
            'name': p['name'],
            'geo_level': p['geo_level']
        }

    mapping_output = OUTPUT_DIR / "psgc-province-mapping.json"
    with open(mapping_output, 'w', encoding='utf-8') as f:
        json.dump(psgc_mapping, f, indent=2)
    print(f"Wrote PSGC mapping to {mapping_output}")

    # Use mapshaper to merge all TopoJSON files
    # First convert each to GeoJSON, merge, then back to TopoJSON
    geojson_files = []
    for topo_file in sorted(TEMP_DIR.glob("provdists-region-*.topo.0.1.json")):
        geojson_out = TEMP_DIR / topo_file.name.replace('.topo.', '.geo.')
        try:
            subprocess.run([
                'mapshaper', str(topo_file),
                '-o', str(geojson_out), 'format=geojson'
            ], check=True, capture_output=True)
            geojson_files.append(str(geojson_out))
        except FileNotFoundError:
            print("mapshaper not found - will use manual merge")
            break

    if geojson_files:
        # Merge with mapshaper
        merged_geojson = TEMP_DIR / "merged-provinces.geo.json"
        merged_topo = OUTPUT_DIR / "provinces-hires.topo.json"

        subprocess.run([
            'mapshaper', '-i', *geojson_files, 'combine-files',
            '-merge-layers',
            '-o', str(merged_topo), 'format=topojson'
        ], check=True)
        print(f"Merged TopoJSON written to {merged_topo}")
    else:
        # Manual merge without mapshaper
        print("Performing manual GeoJSON merge...")

        all_features = []
        for topo_file in sorted(TEMP_DIR.glob("provdists-region-*.topo.0.1.json")):
            with open(topo_file, 'r', encoding='utf-8') as f:
                data = json.load(f)

            # TopoJSON has arcs that need to be preserved per-file
            # For simplicity, we'll write individual province GeoJSONs
            import topojson
            # Actually let's just copy the files and load them separately
            pass

        print("Manual merge not fully implemented - mapshaper needed")
        print("Please install mapshaper: npm install -g mapshaper")

if __name__ == "__main__":
    main()
