#!/usr/bin/env python3
"""
Generate per-year score JSON files for the map.
Filters to 2016-2022 data only.
"""

import json
from pathlib import Path
from collections import defaultdict

PROJECT_ROOT = Path(__file__).parent.parent.parent
DATA_DIR = PROJECT_ROOT / "scripts" / "data"
OUTPUT_DIR = PROJECT_ROOT / "public" / "data"
GEO_DIR = PROJECT_ROOT / "public" / "geo"

OBSERVATIONS_PATH = DATA_DIR / "observations.json"
LGU_MAPPING_PATH = DATA_DIR / "lgu_mapping.json"
PROVINCES_GEO_PATH = GEO_DIR / "provinces-hires.topo.json"

YEARS = range(2016, 2023)  # 2016-2022


def calculate_year_score(observations: list) -> dict:
    """Calculate simple score for a single year's observations."""
    if not observations:
        return None

    total = len(observations)
    not_impl = sum(1 for o in observations if o.get('status') == 'NOT_IMPLEMENTED')
    partial = sum(1 for o in observations if o.get('status') == 'PARTIALLY_IMPLEMENTED')
    implemented = sum(1 for o in observations if o.get('status') == 'IMPLEMENTED')

    known = not_impl + partial + implemented
    if known == 0:
        return None

    # Weighted non-compliance rate
    rate = (not_impl + partial * 0.5) / known
    score = rate * 100

    # Risk level
    if score >= 80:
        risk = 'critical'
    elif score >= 60:
        risk = 'high'
    elif score >= 40:
        risk = 'moderate'
    elif score >= 20:
        risk = 'low'
    else:
        risk = 'minimal'

    return {
        'score': round(score, 1),
        'riskLevel': risk,
        'observationCount': total,
        'implementedPct': round(implemented / known * 100, 1) if known > 0 else 0,
        'notImplementedPct': round(not_impl / known * 100, 1) if known > 0 else 0
    }


def main():
    print("Loading observations...")
    with open(OBSERVATIONS_PATH, 'r', encoding='utf-8') as f:
        all_observations = json.load(f)
    print(f"Loaded {len(all_observations):,} total observations")

    print("Loading LGU mapping...")
    with open(LGU_MAPPING_PATH, 'r', encoding='utf-8') as f:
        lgu_mapping = json.load(f)

    print("Loading province names from geo file...")
    with open(PROVINCES_GEO_PATH, 'r', encoding='utf-8') as f:
        prov_geo = json.load(f)
    # Extract province names from geo data
    province_names = {}
    obj = list(prov_geo['objects'].values())[0]
    for g in obj['geometries']:
        props = g.get('properties', {})
        psgc = str(props.get('psgc', '')).zfill(10)
        name = props.get('name', '')
        if psgc and name:
            province_names[psgc] = name
    print(f"  Loaded {len(province_names)} province names")

    # Filter to 2016-2022 and group by year and PSGC
    by_year_psgc = defaultdict(lambda: defaultdict(list))

    for obs in all_observations:
        year = obs.get('year')
        psgc = obs.get('psgc')
        if year and psgc and 2016 <= year <= 2022:
            by_year_psgc[year][psgc].append(obs)

    # Generate per-year files
    for year in YEARS:
        year_data = by_year_psgc[year]

        lgus = {}
        provinces = defaultdict(lambda: {'observations': [], 'lgus': []})

        for psgc, observations in year_data.items():
            score_data = calculate_year_score(observations)
            if score_data:
                lgu_info = lgu_mapping.get(psgc, {})
                prov_psgc = lgu_info.get('province_psgc', '')
                # Use full 10-digit PSGC code for matching geo data (padded with zeros)
                prov_code = str(prov_psgc).zfill(10) if prov_psgc else ''
                # Also pad the LGU PSGC to 10 digits
                lgu_psgc = str(psgc).zfill(10)

                # Get province name from geo data (authoritative source)
                prov_name = province_names.get(prov_code, '')

                lgus[lgu_psgc] = {
                    'name': lgu_info.get('name', 'Unknown'),
                    'province': prov_name,
                    'provinceCode': prov_code,
                    **score_data
                }

                # Aggregate for province
                if prov_code:
                    provinces[prov_code]['observations'].extend(observations)
                    provinces[prov_code]['lgus'].append(lgu_psgc)

        # Calculate province-level scores
        province_scores = {}
        for prov_code, prov_data in provinces.items():
            score_data = calculate_year_score(prov_data['observations'])
            if score_data:
                # Get province name from geo data (authoritative source)
                prov_name = province_names.get(prov_code, '')

                province_scores[prov_code] = {
                    'name': prov_name,
                    'lguCount': len(prov_data['lgus']),
                    **score_data
                }

        # Write LGU scores
        lgu_output = OUTPUT_DIR / f"scores-{year}.json"
        with open(lgu_output, 'w', encoding='utf-8') as f:
            json.dump({'year': year, 'lgus': lgus}, f, separators=(',', ':'))
        print(f"  {year}: {len(lgus)} LGUs -> {lgu_output.name}")

        # Write province scores
        prov_output = OUTPUT_DIR / f"province-scores-{year}.json"
        with open(prov_output, 'w', encoding='utf-8') as f:
            json.dump({'year': year, 'provinces': province_scores}, f, separators=(',', ':'))
        print(f"  {year}: {len(province_scores)} provinces -> {prov_output.name}")

    # Create empty disallowances placeholder
    disallowances = {
        'description': 'Disallowances dataset - to be populated',
        'lgus': {},
        'provinces': {}
    }
    disallowances_output = OUTPUT_DIR / "disallowances.json"
    with open(disallowances_output, 'w', encoding='utf-8') as f:
        json.dump(disallowances, f, indent=2)
    print(f"\nCreated empty disallowances placeholder: {disallowances_output.name}")

    print("\nDone!")


if __name__ == "__main__":
    main()
