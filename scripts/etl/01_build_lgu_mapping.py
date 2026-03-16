#!/usr/bin/env python3
"""
Build canonical LGU mapping table with PSGC codes from TopoJSON.

This script:
1. Loads PSGC codes and LGU names from TopoJSON boundary files
2. Parses all 9 CSV files (2016-2024) to extract unique LGU identifiers
3. Matches LGU names to PSGC codes using fuzzy matching
4. Outputs a canonical mapping table for data normalization

The PSGC codes enable geographic joins with TopoJSON map boundaries.
"""

import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

# Add parent directories to path for imports when run as script
SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

# Import config (sets csv.field_size_limit at import)
from scripts.etl.config import CSV_FILES, YEARS


def normalize_name(name: str) -> str:
    """
    Normalize LGU name for fuzzy matching.

    Removes: spaces, punctuation, common suffixes (city, municipality)
    Lowercase, handles special characters (Las Pinas -> laspinas)
    """
    if not name:
        return ''

    normalized = name.lower()

    # Remove common suffixes
    normalized = re.sub(r'\s*(city|municipality|mun\.?|muni\.?)$', '', normalized, flags=re.IGNORECASE)

    # Remove "city of" prefix
    normalized = re.sub(r'^city\s+of\s+', '', normalized, flags=re.IGNORECASE)

    # Remove punctuation and special chars
    normalized = re.sub(r'[^\w\s]', '', normalized)

    # Collapse whitespace and remove
    normalized = ''.join(normalized.split())

    return normalized


def load_psgc_from_topojson() -> dict:
    """
    Load PSGC codes and LGU info from TopoJSON boundary file.

    Returns:
        dict: normalized_name -> {psgc, name, province_psgc, adm1_psgc, geo_level}
    """
    topojson_path = PROJECT_ROOT / 'public' / 'geo' / 'lgus.topo.json'

    with open(topojson_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # Find the geometries - object key is 'municities-provdist'
    objects = data.get('objects', {})
    geometries = []
    for obj_name, obj in objects.items():
        if 'geometries' in obj:
            geometries = obj['geometries']
            break

    lookup = {}
    psgc_to_info = {}

    for geom in geometries:
        props = geom.get('properties', {})
        psgc = str(props.get('psgc', ''))
        name = props.get('name', '')
        province_psgc = str(props.get('province_psgc', ''))
        adm1_psgc = str(props.get('adm1_psgc', ''))
        geo_level = props.get('geo_level', '')

        if not psgc or not name:
            continue

        info = {
            'psgc': psgc,
            'name': name,
            'province_psgc': province_psgc,
            'adm1_psgc': adm1_psgc,
            'geo_level': geo_level,
        }

        # Store by PSGC for later lookup
        psgc_to_info[psgc] = info

        # Store by normalized name
        norm_name = normalize_name(name)
        if norm_name:
            # If collision, prefer shorter original name (less likely to have prefix)
            if norm_name not in lookup or len(name) < len(lookup[norm_name]['name']):
                lookup[norm_name] = info

    print(f"Loaded {len(psgc_to_info)} LGUs from TopoJSON")
    return lookup, psgc_to_info


def parse_id_format_2016_2019(raw_id: str) -> dict:
    """
    Parse 2016-2019 ID format: LGUName_Province-YYYY-OBS#

    Examples:
        Akbar_Basilan-2016-OBS1 -> {lgu: 'akbar', province: 'basilan'}
        LamitanCity_Basilan-2017-OBS1 -> {lgu: 'lamitancity', province: 'basilan'}

    Also handles 2021 format: LGUName_Province_aarYYYY-OBS#
    """
    # Check for special suffixes: _aarYYYY, _arYYYY, _aaYYYY, _ESYYYY, -aarYYYY, etc.
    # These appear before the -OBS# or -UNKNOWN-OBS# part
    # The separator can be underscore or hyphen
    match_special = re.match(r'^(.+?)[_-](?:a{1,2}r?|ES)(?:\d{2,4})?-', raw_id)
    if match_special:
        lgu_province = match_special.group(1)
        # Split by underscore: LGUName_Province
        parts = lgu_province.rsplit('_', 1)
        if len(parts) == 2:
            lgu_name, province = parts
        else:
            lgu_name = parts[0]
            province = ''
        return {
            'lgu': normalize_name(lgu_name),
            'lgu_raw': lgu_name,
            'province': province.lower(),
            'region': '',
        }

    # Extract part before -YYYY- (standard 2016-2019 format)
    match = re.match(r'^(.+?)[-_](\d{4})[-_]', raw_id)
    if not match:
        return None

    lgu_province = match.group(1)

    # Split by underscore: LGUName_Province
    parts = lgu_province.rsplit('_', 1)
    if len(parts) == 2:
        lgu_name, province = parts
    else:
        lgu_name = parts[0]
        province = ''

    return {
        'lgu': normalize_name(lgu_name),
        'lgu_raw': lgu_name,
        'province': province.lower(),
        'region': '',
    }


def parse_id_format_2020_2022(raw_id: str) -> dict:
    """
    Parse 2020-2022 ID format: Region__Type__Province__LGU_Province-YYYY-OBS#

    Examples:
        BARMM__Cities__Basilan__IsabelaCity_Basilan-2020-OBS1
            -> {lgu: 'isabelacity', province: 'basilan', region: 'barmm'}
        NCR__PLM-2020-OBS1 (Province-level, skip)
            -> None
    """
    # Skip Province-level entries
    if '__Provinces__' in raw_id:
        return None

    # Extract part before -YYYY-
    match = re.match(r'^(.+?)[-_](\d{4})[-_]', raw_id)
    if not match:
        return None

    main_part = match.group(1)

    # Split by __
    parts = main_part.split('__')

    if len(parts) >= 4:
        # Region__Type__Province__LGU_Province
        region = parts[0]
        # lgu_type = parts[1]  # Cities, Municipalities
        # province_from_path = parts[2]
        lgu_province = parts[3]

        # LGU_Province format
        lgu_parts = lgu_province.rsplit('_', 1)
        if len(lgu_parts) == 2:
            lgu_name, province = lgu_parts
        else:
            lgu_name = lgu_parts[0]
            province = ''

        return {
            'lgu': normalize_name(lgu_name),
            'lgu_raw': lgu_name,
            'province': province.lower(),
            'region': region.lower(),
        }
    elif len(parts) == 2:
        # Simpler format like NCR__PLM (skip - province level)
        return None

    return None


def parse_id_format_2023(raw_id: str) -> dict:
    """
    Parse 2023 ID format: RegionCode_-_Region__Type__LGU-YYYY-OBS#

    Examples:
        01_-_NCR__Cities__CaloocanCity-2023-OBS1
            -> {lgu: 'caloocancity', region: 'ncr'}
        17_-_BARMM__Municipalities__Akbar-2023-OBS1
            -> {lgu: 'akbar', region: 'barmm'}
    """
    # Extract part before -YYYY-
    match = re.match(r'^(.+?)[-](\d{4})[-]', raw_id)
    if not match:
        return None

    main_part = match.group(1)

    # Pattern: RegionCode_-_Region__Type__LGU
    match2 = re.match(r'^(\d+)_-_([^_]+)__([^_]+)__(.+)$', main_part)
    if not match2:
        return None

    # region_code = match2.group(1)
    region = match2.group(2)
    # lgu_type = match2.group(3)
    lgu_name = match2.group(4)

    return {
        'lgu': normalize_name(lgu_name),
        'lgu_raw': lgu_name,
        'province': '',
        'region': region.lower(),
    }


def parse_id_format_2024(raw_id: str) -> dict:
    """
    Parse 2024 ID format: RegionCode-Region__Type__LGU-YYYY-OBS#

    Examples:
        01-NCR__Cities__CaloocanCity-2024-OBS1
            -> {lgu: 'caloocancity', region: 'ncr'}
    """
    # Pattern: RegionCode-Region__Type__LGU-YYYY-OBS#
    match = re.match(r'^(\d+)-([^_]+)__([^_]+)__(.+?)-(\d{4})-', raw_id)
    if not match:
        return None

    # region_code = match.group(1)
    region = match.group(2)
    # lgu_type = match.group(3)
    lgu_name = match.group(4)

    return {
        'lgu': normalize_name(lgu_name),
        'lgu_raw': lgu_name,
        'province': '',
        'region': region.lower(),
    }


def normalize_lgu_id(raw_id: str, year: int) -> dict:
    """
    Route to appropriate parser based on year.

    Returns:
        dict with keys: lgu, lgu_raw, province, region
        or None if parsing failed
    """
    if year <= 2019 or year == 2021:
        return parse_id_format_2016_2019(raw_id)
    elif year in [2020, 2022]:
        return parse_id_format_2020_2022(raw_id)
    elif year == 2023:
        return parse_id_format_2023(raw_id)
    elif year == 2024:
        return parse_id_format_2024(raw_id)
    else:
        return None


def match_to_psgc(parsed: dict, psgc_lookup: dict) -> str:
    """
    Match parsed LGU info to PSGC code.

    Tries:
    1. Exact normalized name match
    2. Name + province combo
    3. Name without "city" suffix

    Returns:
        PSGC code or None
    """
    if not parsed:
        return None

    lgu_norm = parsed['lgu']
    province = parsed.get('province', '')

    # 1. Exact match
    if lgu_norm in psgc_lookup:
        return psgc_lookup[lgu_norm]['psgc']

    # 2. Try with province appended (e.g., "akbarbasilan")
    if province:
        combo = lgu_norm + province.replace(' ', '')
        if combo in psgc_lookup:
            return psgc_lookup[combo]['psgc']

    # 3. Try removing "city" from normalized name
    without_city = lgu_norm.replace('city', '')
    if without_city and without_city != lgu_norm and without_city in psgc_lookup:
        return psgc_lookup[without_city]['psgc']

    return None


def main():
    """Build canonical LGU mapping from CSVs and TopoJSON."""
    print("Building LGU mapping table...")
    print("=" * 60)

    # Load PSGC lookup from TopoJSON
    psgc_lookup, psgc_to_info = load_psgc_from_topojson()

    # Track unique LGUs from CSVs
    # Key: normalized LGU name, Value: info dict
    lgu_entries = {}
    unmatched_lgus = defaultdict(set)  # normalized_name -> set of raw_ids
    parse_errors = []

    # Process each CSV file
    for year in YEARS:
        csv_path = CSV_FILES[year]
        if not csv_path.exists():
            print(f"Warning: {csv_path} not found, skipping")
            continue

        print(f"Processing {year}...")
        row_count = 0
        year_lgus = set()

        with open(csv_path, 'r', encoding='utf-8', errors='replace') as f:
            reader = csv.DictReader(f)
            for row in reader:
                row_count += 1
                raw_id = row.get('ID', '')

                parsed = normalize_lgu_id(raw_id, year)
                if not parsed:
                    # Only log non-Province entries as errors
                    if '__Provinces__' not in raw_id and 'Prov-' not in raw_id:
                        parse_errors.append(f"{year}: {raw_id[:60]}")
                    continue

                lgu_norm = parsed['lgu']
                year_lgus.add(lgu_norm)

                # Check if we already have this LGU
                if lgu_norm in lgu_entries:
                    # Add raw_id to existing entry
                    lgu_entries[lgu_norm]['raw_ids'].add(parsed['lgu_raw'])
                    lgu_entries[lgu_norm]['years'].add(year)
                    # Update province/region if we have better info
                    if parsed.get('province') and not lgu_entries[lgu_norm].get('province'):
                        lgu_entries[lgu_norm]['province'] = parsed['province']
                    if parsed.get('region') and not lgu_entries[lgu_norm].get('region'):
                        lgu_entries[lgu_norm]['region'] = parsed['region']
                else:
                    # New LGU entry
                    psgc = match_to_psgc(parsed, psgc_lookup)

                    lgu_entries[lgu_norm] = {
                        'lgu_norm': lgu_norm,
                        'raw_ids': {parsed['lgu_raw']},
                        'province': parsed.get('province', ''),
                        'region': parsed.get('region', ''),
                        'psgc': psgc,
                        'years': {year},
                    }

                    if not psgc:
                        unmatched_lgus[lgu_norm].add(parsed['lgu_raw'])

        print(f"  Rows: {row_count:,}, Unique LGUs this year: {len(year_lgus)}")

    print("=" * 60)
    print(f"Total unique LGUs from CSVs: {len(lgu_entries)}")
    print(f"Matched to PSGC: {sum(1 for e in lgu_entries.values() if e['psgc'])}")
    print(f"Unmatched: {len(unmatched_lgus)}")

    # Try additional matching for unmatched
    print("\nAttempting additional matching for unmatched LGUs...")
    additional_matched = 0

    for lgu_norm in list(unmatched_lgus.keys()):
        entry = lgu_entries[lgu_norm]

        # Try fuzzy matching: find PSGC entries that contain this name
        for psgc_norm, psgc_info in psgc_lookup.items():
            # Check if normalized names are substrings of each other
            if lgu_norm in psgc_norm or psgc_norm in lgu_norm:
                if len(lgu_norm) >= 4:  # Avoid very short matches
                    entry['psgc'] = psgc_info['psgc']
                    entry['matched_name'] = psgc_info['name']
                    del unmatched_lgus[lgu_norm]
                    additional_matched += 1
                    break

    print(f"Additional matched: {additional_matched}")
    print(f"Final unmatched: {len(unmatched_lgus)}")

    # Build output structure - consolidate by PSGC code
    # This creates a canonical mapping with PSGC as primary identifier
    psgc_consolidated = {}
    unmatched_entries = {}

    for lgu_norm, entry in lgu_entries.items():
        psgc = entry['psgc']

        if psgc:
            # Consolidate entries with same PSGC
            if psgc not in psgc_consolidated:
                info = psgc_to_info[psgc]
                psgc_consolidated[psgc] = {
                    'psgc': psgc,
                    'name': info['name'],
                    'province_psgc': info.get('province_psgc', ''),
                    'adm1_psgc': info.get('adm1_psgc', ''),
                    'geo_level': info.get('geo_level', ''),
                    'raw_ids': set(),
                    'normalized_keys': set(),
                    'years': set(),
                    'provinces': set(),
                    'regions': set(),
                }
            # Merge data from this entry
            psgc_consolidated[psgc]['raw_ids'].update(entry['raw_ids'])
            psgc_consolidated[psgc]['normalized_keys'].add(lgu_norm)
            psgc_consolidated[psgc]['years'].update(entry['years'])
            if entry['province']:
                psgc_consolidated[psgc]['provinces'].add(entry['province'])
            if entry['region']:
                psgc_consolidated[psgc]['regions'].add(entry['region'])
        else:
            # Keep unmatched entries separate
            unmatched_entries[lgu_norm] = {
                'psgc': '',
                'name': list(entry['raw_ids'])[0],
                'raw_ids': sorted(entry['raw_ids']),
                'years': sorted(entry['years']),
            }

    # Convert sets to sorted lists for JSON serialization
    output = {}
    for psgc, data in psgc_consolidated.items():
        output[psgc] = {
            'psgc': data['psgc'],
            'name': data['name'],
            'province_psgc': data['province_psgc'],
            'adm1_psgc': data['adm1_psgc'],
            'geo_level': data['geo_level'],
            'raw_ids': sorted(data['raw_ids']),
            'normalized_keys': sorted(data['normalized_keys']),
            'years': sorted(data['years']),
            'provinces': sorted(data['provinces']),
            'regions': sorted(data['regions']),
        }

    # Add unmatched entries with their normalized key
    for norm_key, data in unmatched_entries.items():
        output[f"unmatched_{norm_key}"] = data

    # Create output directory
    output_dir = PROJECT_ROOT / 'scripts' / 'data'
    output_dir.mkdir(parents=True, exist_ok=True)

    # Write output
    output_path = output_dir / 'lgu_mapping.json'
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\nOutput written to: {output_path}")
    print(f"Total LGU entries: {len(output)}")

    # Summary stats
    matched_count = len(psgc_consolidated)
    unmatched_count = len(unmatched_entries)
    print(f"\nSummary:")
    print(f"  Unique LGUs with PSGC: {matched_count}")
    print(f"  Unmatched entries: {unmatched_count}")
    print(f"  Total entries in output: {len(output)}")

    # Log unmatched to stderr for review
    if unmatched_lgus:
        print(f"\nUnmatched LGUs (logged to stderr):", file=sys.stderr)
        for lgu_norm, raw_ids in sorted(unmatched_lgus.items())[:20]:
            print(f"  {lgu_norm}: {list(raw_ids)[:3]}", file=sys.stderr)
        if len(unmatched_lgus) > 20:
            print(f"  ... and {len(unmatched_lgus) - 20} more", file=sys.stderr)

    # Log parse errors
    if parse_errors:
        print(f"\nParse errors (first 10):", file=sys.stderr)
        for err in parse_errors[:10]:
            print(f"  {err}", file=sys.stderr)
        if len(parse_errors) > 10:
            print(f"  ... and {len(parse_errors) - 10} more", file=sys.stderr)

    return matched_count, unmatched_count


if __name__ == '__main__':
    matched, unmatched = main()
    # Exit with error if match rate is too low
    total = matched + unmatched
    if matched / total < 0.5:
        print(f"\nError: Match rate ({100*matched/total:.1f}%) below 50%", file=sys.stderr)
        sys.exit(1)
