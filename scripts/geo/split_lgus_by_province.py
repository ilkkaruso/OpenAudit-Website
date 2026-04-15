#!/usr/bin/env python3
"""
Split municipality TopoJSON into per-province files for lazy loading.
"""

import json
from pathlib import Path
from collections import defaultdict
import re

PROJECT_ROOT = Path(__file__).parent.parent.parent
GEO_DIR = PROJECT_ROOT / "public" / "geo"
INPUT_FILE = GEO_DIR / "municities-hires.topo.json"
OUTPUT_DIR = GEO_DIR / "lgus"


def slugify(name: str) -> str:
    """Convert province name to filename-safe slug."""
    slug = name.lower()
    slug = re.sub(r'[^a-z0-9]+', '-', slug)
    slug = slug.strip('-')
    return slug


def get_province_code(props: dict) -> str:
    """Extract province code from properties."""
    # Use province_psgc if available, otherwise derive from psgc
    prov_psgc = props.get('province_psgc')
    if prov_psgc:
        return str(prov_psgc)[:5]

    psgc = str(props.get('psgc', props.get('PSGC', '')))
    return psgc[:5] if len(psgc) >= 5 else ""


def main():
    print(f"Loading {INPUT_FILE}...")
    with open(INPUT_FILE, 'r', encoding='utf-8') as f:
        topo = json.load(f)

    # Get the geometry objects
    obj_name = list(topo['objects'].keys())[0]
    geometries = topo['objects'][obj_name]['geometries']

    print(f"Found {len(geometries)} geometries")

    # Group by province
    by_province = defaultdict(list)
    province_names = {}

    for geom in geometries:
        props = geom.get('properties', {})
        prov_code = get_province_code(props)

        if not prov_code:
            continue

        by_province[prov_code].append(geom)

        # Try to get province name from the LGU name or use a placeholder
        # Note: This TopoJSON doesn't have province names, so we'll use codes
        if prov_code not in province_names:
            province_names[prov_code] = f"province-{prov_code}"

    print(f"Found {len(by_province)} provinces")

    # Create output directory
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Write province mapping file
    mapping = {}

    for prov_code, geoms in sorted(by_province.items()):
        prov_name = province_names.get(prov_code, f'province-{prov_code}')
        slug = slugify(prov_name)

        # Create TopoJSON for this province
        prov_topo = {
            "type": "Topology",
            "arcs": topo["arcs"],  # Include all arcs (could optimize later)
            "objects": {
                "lgus": {
                    "type": "GeometryCollection",
                    "geometries": geoms
                }
            }
        }

        if "transform" in topo:
            prov_topo["transform"] = topo["transform"]

        output_file = OUTPUT_DIR / f"{slug}.topo.json"
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(prov_topo, f, separators=(',', ':'))

        mapping[prov_code] = {
            "name": prov_name,
            "slug": slug,
            "file": f"lgus/{slug}.topo.json",
            "lgu_count": len(geoms)
        }

        print(f"  {prov_code}: {len(geoms)} LGUs -> {slug}.topo.json")

    # Write mapping file
    mapping_file = GEO_DIR / "province-mapping.json"
    with open(mapping_file, 'w', encoding='utf-8') as f:
        json.dump(mapping, f, indent=2, ensure_ascii=False)

    print(f"\nWrote {len(mapping)} province files to {OUTPUT_DIR}/")
    print(f"Mapping saved to {mapping_file}")


if __name__ == "__main__":
    main()
