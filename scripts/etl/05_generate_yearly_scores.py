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

OBSERVATIONS_PATH = DATA_DIR / "observations.json"
LGU_MAPPING_PATH = DATA_DIR / "lgu_mapping.json"

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
                prov_code = str(prov_psgc)[:5] if prov_psgc else ''

                lgus[psgc] = {
                    'name': lgu_info.get('name', 'Unknown'),
                    'province': lgu_info.get('province_name', ''),
                    'provinceCode': prov_code,
                    **score_data
                }

                # Aggregate for province
                if prov_code:
                    provinces[prov_code]['observations'].extend(observations)
                    provinces[prov_code]['lgus'].append(psgc)

        # Calculate province-level scores
        province_scores = {}
        for prov_code, prov_data in provinces.items():
            score_data = calculate_year_score(prov_data['observations'])
            if score_data:
                # Get province name from first LGU
                prov_name = ''
                for psgc in prov_data['lgus']:
                    if psgc in lgus:
                        prov_name = lgus[psgc]['province']
                        break

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
