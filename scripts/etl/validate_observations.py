#!/usr/bin/env python3
"""
Validate observation quality metrics.

This script:
1. Loads observations.json
2. Calculates and prints quality metrics
3. Validates PSGC codes against lgu_mapping.json
4. Runs data quality checks
5. Exits 0 if all checks pass, 1 if any fail
"""

import json
import sys
from collections import defaultdict
from pathlib import Path

# Project paths
SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent
DATA_DIR = PROJECT_ROOT / 'scripts' / 'data'


def load_data():
    """Load observations and LGU mapping."""
    observations_path = DATA_DIR / 'observations.json'
    mapping_path = DATA_DIR / 'lgu_mapping.json'

    with open(observations_path, 'r', encoding='utf-8') as f:
        observations = json.load(f)

    with open(mapping_path, 'r', encoding='utf-8') as f:
        lgu_mapping = json.load(f)

    return observations, lgu_mapping


def analyze_metrics(observations):
    """Calculate and return quality metrics."""
    total = len(observations)

    # Status distribution
    status_counts = defaultdict(int)
    for obs in observations:
        status_counts[obs['status']] += 1

    # Year distribution
    year_counts = defaultdict(int)
    for obs in observations:
        year_counts[obs['year']] += 1

    # Unique PSGCs
    unique_psgcs = set(obs['psgc'] for obs in observations)

    # Region distribution (first 2 digits of PSGC)
    region_counts = defaultdict(int)
    for psgc in unique_psgcs:
        # PSGC format: first 2 digits are region
        region = str(psgc).zfill(10)[:2]
        region_counts[region] += 1

    return {
        'total': total,
        'status_counts': dict(status_counts),
        'year_counts': dict(year_counts),
        'unique_psgcs': unique_psgcs,
        'region_counts': dict(region_counts),
    }


def validate_psgc_codes(observations, lgu_mapping):
    """Validate all observation PSGC codes exist in lgu_mapping."""
    # Get valid PSGCs from mapping
    valid_psgcs = set()
    for key, entry in lgu_mapping.items():
        psgc = entry.get('psgc', '')
        if psgc and not key.startswith('unmatched_'):
            valid_psgcs.add(psgc)

    # Check observations
    orphaned = set()
    invalid_format = set()

    for obs in observations:
        psgc = obs['psgc']

        # Check format (should be 9 or 10 digits)
        if not str(psgc).isdigit() or len(str(psgc)) < 9 or len(str(psgc)) > 10:
            invalid_format.add(psgc)
            continue

        if psgc not in valid_psgcs:
            orphaned.add(psgc)

    return valid_psgcs, orphaned, invalid_format


def run_checks(metrics, orphaned, invalid_format):
    """Run data quality checks and return pass/fail status."""
    checks = []
    total = metrics['total']
    status_counts = metrics['status_counts']
    year_counts = metrics['year_counts']
    unique_psgcs = metrics['unique_psgcs']

    # Check 1: UNKNOWN < 60%
    unknown_pct = (status_counts.get('UNKNOWN', 0) / total * 100) if total > 0 else 0
    check1 = unknown_pct < 60
    checks.append(('UNKNOWN status < 60%', check1, f'{unknown_pct:.1f}%'))

    # Check 2: Unique LGUs between 1,200-1,800
    lgu_count = len(unique_psgcs)
    check2 = 1200 <= lgu_count <= 1800
    checks.append(('Unique LGUs between 1,200-1,800', check2, str(lgu_count)))

    # Check 3: Total observations > 350,000
    check3 = total > 350000
    checks.append(('Total observations > 350,000', check3, f'{total:,}'))

    # Check 4: Each year has > 8,000 observations (2022 is smaller dataset)
    year_check = all(
        count > 8000 for year, count in year_counts.items()
        if 2016 <= year <= 2024
    )
    min_year = min(
        (year, count) for year, count in year_counts.items()
        if 2016 <= year <= 2024
    )
    checks.append(('Each year > 8,000 observations', year_check, f'min: {min_year[0]}={min_year[1]:,}'))

    # Check 5: All PSGC codes are valid format (9-10 digits)
    check5 = len(invalid_format) == 0
    checks.append(('All PSGCs valid format', check5, f'{len(invalid_format)} invalid'))

    # Check 6: No orphaned PSGCs (not in mapping)
    check6 = len(orphaned) == 0
    checks.append(('All PSGCs in mapping', check6, f'{len(orphaned)} orphaned'))

    return checks


def print_report(metrics, valid_psgcs, orphaned, invalid_format, checks):
    """Print formatted quality report."""
    total = metrics['total']
    status_counts = metrics['status_counts']
    year_counts = metrics['year_counts']
    unique_psgcs = metrics['unique_psgcs']
    region_counts = metrics['region_counts']

    print("=" * 60)
    print("Observation Quality Report")
    print("=" * 60)
    print(f"\nTotal observations: {total:,}")

    print("\nYear Distribution:")
    for year in sorted(year_counts.keys()):
        count = year_counts[year]
        pct = (count / total * 100) if total > 0 else 0
        print(f"  {year}: {count:>7,} ({pct:>5.1f}%)")

    print("\nStatus Distribution:")
    for status in ['IMPLEMENTED', 'NOT_IMPLEMENTED', 'PARTIALLY_IMPLEMENTED', 'ONGOING', 'UNKNOWN']:
        count = status_counts.get(status, 0)
        pct = (count / total * 100) if total > 0 else 0
        print(f"  {status:24s} {count:>7,} ({pct:>5.1f}%)")

    print(f"\nUnique LGUs (PSGC): {len(unique_psgcs):,}")

    print("\nLGUs per Region (PSGC prefix):")
    for region in sorted(region_counts.keys()):
        count = region_counts[region]
        print(f"  Region {region}: {count:>4} LGUs")

    print("\nPSGC Validation:")
    print(f"  Valid PSGCs in mapping: {len(valid_psgcs):,}")
    print(f"  Invalid format PSGCs: {len(invalid_format)}")
    print(f"  Orphaned PSGCs: {len(orphaned)}")

    print("\n" + "=" * 60)
    print("Quality Checks")
    print("=" * 60)

    all_passed = True
    for name, passed, value in checks:
        status = "PASS" if passed else "FAIL"
        symbol = "[x]" if passed else "[ ]"
        print(f"  {symbol} {name}: {value} - {status}")
        if not passed:
            all_passed = False

    print("=" * 60)
    if all_passed:
        print("All checks passed!")
    else:
        print("Some checks FAILED!")
    print("=" * 60)

    return all_passed


def main():
    """Main entry point."""
    print("Loading data...")
    observations, lgu_mapping = load_data()
    print(f"Loaded {len(observations):,} observations")
    print(f"Loaded {len(lgu_mapping):,} LGU mapping entries")

    print("\nAnalyzing metrics...")
    metrics = analyze_metrics(observations)

    print("Validating PSGC codes...")
    valid_psgcs, orphaned, invalid_format = validate_psgc_codes(observations, lgu_mapping)

    print("Running quality checks...")
    checks = run_checks(metrics, orphaned, invalid_format)

    print("\n")
    all_passed = print_report(metrics, valid_psgcs, orphaned, invalid_format, checks)

    return 0 if all_passed else 1


if __name__ == '__main__':
    sys.exit(main())
