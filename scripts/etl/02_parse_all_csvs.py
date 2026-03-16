#!/usr/bin/env python3
"""
Parse all CSV files and extract observations with PSGC codes.

This script:
1. Loads the canonical LGU mapping (lgu_mapping.json)
2. Parses all 9 CSV files (2016-2024)
3. Normalizes status values using config.normalize_status()
4. Links each observation to its LGU via PSGC code
5. Outputs consolidated observations.json

Memory consideration: Output is ~100-200MB as intermediate artifact.
Final public JSON will be split by LGU in later processing.
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
from scripts.etl.config import CSV_FILES, YEARS, normalize_status


def load_lgu_mapping() -> dict:
    """
    Load LGU mapping and build reverse lookup: raw_id -> psgc_code.

    Returns:
        dict: Maps raw_id (normalized) and other variants to PSGC code
    """
    mapping_path = PROJECT_ROOT / 'scripts' / 'data' / 'lgu_mapping.json'

    with open(mapping_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    lookup = {}

    for key, entry in data.items():
        psgc = entry.get('psgc', '')

        # Skip unmatched entries
        if not psgc or key.startswith('unmatched_'):
            continue

        # Add all raw_ids as lookup keys
        for raw_id in entry.get('raw_ids', []):
            normalized = normalize_lgu_name(raw_id)
            if normalized:
                lookup[normalized] = psgc

        # Add all normalized_keys as lookup keys
        for norm_key in entry.get('normalized_keys', []):
            if norm_key:
                lookup[norm_key] = psgc

        # Add PSGC itself as lookup (for direct matches)
        lookup[psgc] = psgc

    print(f"Loaded LGU lookup with {len(lookup)} keys -> {len(set(lookup.values()))} unique PSGCs")
    return lookup


def normalize_lgu_name(name: str) -> str:
    """
    Normalize LGU name for lookup matching.

    Mirrors the normalization in 01_build_lgu_mapping.py:
    - Lowercase
    - Remove common suffixes (city, municipality)
    - Remove punctuation
    - Collapse whitespace
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


def extract_lgu_from_id(raw_id: str, year: int) -> str:
    """
    Extract LGU name from observation ID based on year format.

    Returns normalized LGU name for lookup, or None if extraction fails.
    """
    if not raw_id:
        return None

    # Format 2016-2019, 2021: LGUName_Province-YYYY-OBS# or LGUName_Province_aarYYYY-OBS#
    if year <= 2019 or year == 2021:
        # Check for special suffixes first
        match_special = re.match(r'^(.+?)[_-](?:a{1,2}r?|ES)(?:\d{2,4})?-', raw_id)
        if match_special:
            lgu_province = match_special.group(1)
            parts = lgu_province.rsplit('_', 1)
            if parts:
                return normalize_lgu_name(parts[0])

        # Standard format
        match = re.match(r'^(.+?)[-_](\d{4})[-_]', raw_id)
        if match:
            lgu_province = match.group(1)
            parts = lgu_province.rsplit('_', 1)
            if parts:
                return normalize_lgu_name(parts[0])

    # Format 2020, 2022: Region__Type__Province__LGU_Province-YYYY-OBS#
    elif year in [2020, 2022]:
        # Skip Province-level entries
        if '__Provinces__' in raw_id:
            return None

        match = re.match(r'^(.+?)[-_](\d{4})[-_]', raw_id)
        if match:
            main_part = match.group(1)
            parts = main_part.split('__')

            if len(parts) >= 4:
                lgu_province = parts[3]
                lgu_parts = lgu_province.rsplit('_', 1)
                if lgu_parts:
                    return normalize_lgu_name(lgu_parts[0])

    # Format 2023: RegionCode_-_Region__Type__LGU-YYYY-OBS#
    elif year == 2023:
        match = re.match(r'^(.+?)[-](\d{4})[-]', raw_id)
        if match:
            main_part = match.group(1)
            match2 = re.match(r'^(\d+)_-_([^_]+)__([^_]+)__(.+)$', main_part)
            if match2:
                return normalize_lgu_name(match2.group(4))

    # Format 2024: RegionCode-Region__Type__LGU-YYYY-OBS#
    elif year == 2024:
        match = re.match(r'^(\d+)-([^_]+)__([^_]+)__(.+?)-(\d{4})-', raw_id)
        if match:
            return normalize_lgu_name(match.group(4))

    return None


def extract_year_from_id(raw_id: str, default_year: int) -> int:
    """
    Extract year from observation ID.

    Args:
        raw_id: The observation ID string
        default_year: Fallback year (from CSV file) if extraction fails or invalid

    Returns:
        Year as int (validated to be in 2016-2024 range, or default_year)
    """
    # Look for -YYYY- pattern (most common: -2016-OBS1)
    match = re.search(r'-(\d{4})-', raw_id)
    if match:
        year = int(match.group(1))
        if 2016 <= year <= 2024:
            return year

    # Look for _YYYY_ or _YYYY- pattern
    match = re.search(r'[_-](\d{4})[_-]', raw_id)
    if match:
        year = int(match.group(1))
        if 2016 <= year <= 2024:
            return year

    # Return the file year as fallback
    return default_year


def parse_observation(row: dict, year: int, lgu_lookup: dict) -> dict:
    """
    Parse a single observation row.

    Args:
        row: CSV row as dict
        year: Year of the CSV file
        lgu_lookup: LGU name -> PSGC code mapping

    Returns:
        Structured observation dict, or None if parsing fails
    """
    raw_id = row.get('ID', '')

    if not raw_id or not raw_id.strip():
        return None

    # Extract LGU name and look up PSGC
    lgu_name = extract_lgu_from_id(raw_id, year)

    if not lgu_name:
        return None

    psgc_code = lgu_lookup.get(lgu_name)

    if not psgc_code:
        # Try with "city" appended (some entries are stored this way)
        psgc_code = lgu_lookup.get(lgu_name + 'city')

    if not psgc_code:
        return None

    # Extract year from ID (validated, falls back to file year)
    obs_year = extract_year_from_id(raw_id, year)

    # Normalize status
    raw_status = row.get('STATUS OF IMPLEMENTATION', '')
    normalized_status = normalize_status(raw_status)

    return {
        'id': raw_id,
        'psgc': psgc_code,
        'year': obs_year,
        'recommendation': row.get('RECOMMENDATION', '').strip() if row.get('RECOMMENDATION') else '',
        'management_action': row.get('MANAGEMENT ACTION', '').strip() if row.get('MANAGEMENT ACTION') else '',
        'status': normalized_status,
        'reason': row.get('REASON FOR NON/PARTIAL IMPLEMENTATION', '').strip() if row.get('REASON FOR NON/PARTIAL IMPLEMENTATION') else '',
    }


def main():
    """Main entry point."""
    print("Parsing all CSV files...")
    print("=" * 60)

    # Load LGU mapping
    lgu_lookup = load_lgu_mapping()

    # Track observations and stats
    observations = []
    status_counts = defaultdict(int)
    year_counts = defaultdict(int)
    failed_lookups = 0
    skipped_empty = 0
    skipped_province = 0

    # Process each CSV file
    for year in YEARS:
        csv_path = CSV_FILES[year]

        if not csv_path.exists():
            print(f"Warning: {csv_path} not found, skipping")
            continue

        print(f"Processing {year}...")
        row_count = 0
        year_obs = 0
        year_failed = 0

        with open(csv_path, 'r', encoding='utf-8', errors='replace') as f:
            reader = csv.DictReader(f)

            for row in reader:
                row_count += 1
                raw_id = row.get('ID', '')

                # Skip empty rows
                if not raw_id or not raw_id.strip():
                    skipped_empty += 1
                    continue

                # Skip province-level entries
                if '__Provinces__' in raw_id or 'Prov-' in raw_id:
                    skipped_province += 1
                    continue

                obs = parse_observation(row, year, lgu_lookup)

                if obs:
                    observations.append(obs)
                    status_counts[obs['status']] += 1
                    year_counts[obs['year']] += 1
                    year_obs += 1
                else:
                    year_failed += 1
                    failed_lookups += 1
                    # Log first few failures per year
                    if year_failed <= 5:
                        print(f"  Failed lookup: {raw_id[:60]}...", file=sys.stderr)

        print(f"  Processed {year}: {year_obs:,} observations ({year_failed:,} failed lookups)")

    print("=" * 60)

    # Output statistics
    print(f"\nTotal observations: {len(observations):,}")
    print(f"Skipped empty rows: {skipped_empty:,}")
    print(f"Skipped province entries: {skipped_province:,}")
    print(f"Failed LGU lookups: {failed_lookups:,}")

    # Status distribution
    print(f"\nStatus distribution:")
    total = len(observations)
    for status in ['IMPLEMENTED', 'NOT_IMPLEMENTED', 'PARTIALLY_IMPLEMENTED', 'ONGOING', 'UNKNOWN']:
        count = status_counts[status]
        pct = (count / total * 100) if total > 0 else 0
        print(f"  {status}: {count:,} ({pct:.1f}%)")

    # Year distribution
    print(f"\nYear distribution:")
    for year in sorted(year_counts.keys()):
        count = year_counts[year]
        pct = (count / total * 100) if total > 0 else 0
        print(f"  {year}: {count:,} ({pct:.1f}%)")

    # Unique PSGCs
    unique_psgcs = len(set(obs['psgc'] for obs in observations))
    print(f"\nUnique LGUs (PSGCs): {unique_psgcs:,}")

    # Write output
    output_dir = PROJECT_ROOT / 'scripts' / 'data'
    output_dir.mkdir(parents=True, exist_ok=True)

    output_path = output_dir / 'observations.json'
    print(f"\nWriting to: {output_path}")

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(observations, f, ensure_ascii=False)

    # Check file size
    file_size = output_path.stat().st_size / (1024 * 1024)
    print(f"Output file size: {file_size:.1f} MB")

    print("\nDone!")

    return len(observations), failed_lookups


if __name__ == '__main__':
    count, failed = main()

    # Exit with error if too many failures
    if count == 0:
        print("Error: No observations extracted", file=sys.stderr)
        sys.exit(1)

    failure_rate = failed / (count + failed) if (count + failed) > 0 else 0
    if failure_rate > 0.10:  # More than 10% failure rate
        print(f"Warning: High failure rate ({failure_rate*100:.1f}%)", file=sys.stderr)
