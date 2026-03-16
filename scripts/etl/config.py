"""
ETL Configuration for OpenAudit LGU Data Processing

This module provides shared configuration for processing COA audit extraction CSVs,
including status normalization and CSV field size limits for handling large CONTENT fields.
"""

import csv
import sys
from pathlib import Path

# Set CSV field size limit at import time to handle CONTENT fields >128KB
# (required for 2016, 2017, 2018, 2020, 2021 files per research)
CSV_FIELD_SIZE_LIMIT = sys.maxsize // 10  # Platform-safe maximum
csv.field_size_limit(CSV_FIELD_SIZE_LIMIT)

# Project root directory (relative to this config file)
PROJECT_ROOT = Path(__file__).parent.parent.parent

# Years covered by audit data
YEARS = list(range(2016, 2025))

# CSV file paths by year
CSV_FILES = {
    year: PROJECT_ROOT / f"audit_extraction_LGU_{year}.csv"
    for year in YEARS
}

# Status normalization mapping
# Maps canonical status values to their variations found in raw data
# ~50+ variations map to 4 canonical values
STATUS_MAP = {
    'IMPLEMENTED': [
        'implemented',
        'fully implemented',
        'fully complied',
        'the management was able to comply',
        'complied',
        'full compliance',
        'fully compliance',
        'already implemented',
        'has been implemented',
        'been implemented',
        'management complied',
        'lgu complied',
        'the lgu complied',
        'the management complied',
        'recommendation implemented',
        'already complied',
    ],
    'NOT_IMPLEMENTED': [
        'not implemented',
        'unimplemented',
        'non implementation',
        'not yet implemented',
        'no implementation',
        'not complied',
        'non-implementation',
        'non-compliance',
        'noncompliance',
        'no compliance',
        'has not been implemented',
        'not yet complied',
        'management did not comply',
        'lgu did not comply',
        'the lgu did not comply',
        'no action taken',
        'not acted upon',
    ],
    'PARTIALLY_IMPLEMENTED': [
        'partially implemented',
        'partially complied',
        'partial implementation',
        'partial compliance',
        'partly implemented',
        'partly complied',
        'partially',
        'partial',
        'some implementation',
        'some compliance',
        'in partial compliance',
        'partially addressed',
    ],
    'ONGOING': [
        'ongoing',
        'on going',
        'on-going',
        'for implementation',
        'being implemented',
        'in progress',
        'in the process',
        'for compliance',
        'still ongoing',
        'currently being implemented',
        'continuous implementation',
        'continuous compliance',
        'for continuous implementation',
        'under implementation',
        'implementation ongoing',
    ],
}

# Build reverse lookup for faster matching
_STATUS_VARIATIONS = {}
for canonical, variations in STATUS_MAP.items():
    for variation in variations:
        _STATUS_VARIATIONS[variation.lower()] = canonical


def normalize_status(raw: str) -> str:
    """
    Normalize a raw status string to a canonical value.

    Args:
        raw: Raw status string from CSV (may be None, empty, or dirty)

    Returns:
        One of: IMPLEMENTED, NOT_IMPLEMENTED, PARTIALLY_IMPLEMENTED, ONGOING, UNKNOWN
    """
    if raw is None or not str(raw).strip():
        return 'UNKNOWN'

    # Normalize: lowercase, collapse whitespace, strip
    normalized = ' '.join(str(raw).lower().split())

    # Try exact match first
    if normalized in _STATUS_VARIATIONS:
        return _STATUS_VARIATIONS[normalized]

    # Try substring matching for longer status descriptions
    # Sort by length descending to match longest patterns first
    for variation, canonical in sorted(_STATUS_VARIATIONS.items(),
                                       key=lambda x: len(x[0]), reverse=True):
        if variation in normalized:
            return canonical

    return 'UNKNOWN'


# Region code to name mapping for ID parsing
REGION_CODES = {
    '01': 'NCR',
    '02': 'CAR',
    '03': 'REGION I',
    '04': 'REGION II',
    '05': 'REGION III',
    '06': 'REGION IV-A',
    '07': 'REGION IV-B',
    '08': 'REGION V',
    '09': 'REGION VI',
    '10': 'REGION VII',
    '11': 'REGION VIII',
    '12': 'REGION IX',
    '13': 'REGION X',
    '14': 'REGION XI',
    '15': 'REGION XII',
    '16': 'REGION XIII',
    '17': 'BARMM',
}
