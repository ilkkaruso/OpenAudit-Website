#!/usr/bin/env python3
"""
Generate a combined province scores file aggregating data across all years (2016-2022).
"""

import json
from pathlib import Path
from collections import defaultdict

PROJECT_ROOT = Path(__file__).parent.parent.parent
DATA_DIR = PROJECT_ROOT / "public" / "data"
OUTPUT_PATH = DATA_DIR / "province-scores-all.json"

YEARS = range(2016, 2023)  # 2016-2022


def calculate_trend(scores: list) -> tuple:
    """Calculate trend from list of (year, score) tuples."""
    if len(scores) < 2:
        return 'insufficient_data', 0.0

    scores = sorted(scores, key=lambda x: x[0])
    n = len(scores)
    sum_x = sum(i for i in range(n))
    sum_y = sum(s[1] for s in scores)
    sum_xy = sum(i * s[1] for i, s in enumerate(scores))
    sum_xx = sum(i * i for i in range(n))

    denom = n * sum_xx - sum_x * sum_x
    if denom == 0:
        return 'stable', 0.0

    slope = (n * sum_xy - sum_x * sum_y) / denom

    if slope < -2:
        return 'improving', slope
    elif slope > 2:
        return 'worsening', slope
    else:
        return 'stable', slope


def get_risk_level(score):
    if score is None:
        return 'no_data'
    if score >= 80:
        return 'critical'
    if score >= 60:
        return 'high'
    if score >= 40:
        return 'moderate'
    if score >= 20:
        return 'low'
    return 'minimal'


def main():
    print("Loading per-year province score files...")

    province_yearly = defaultdict(dict)

    for year in YEARS:
        score_file = DATA_DIR / f"province-scores-{year}.json"
        if not score_file.exists():
            print(f"  Warning: {score_file.name} not found")
            continue

        with open(score_file, 'r', encoding='utf-8') as f:
            data = json.load(f)

        for psgc, score_data in data.get('provinces', {}).items():
            province_yearly[psgc][year] = score_data

        print(f"  {year}: {len(data.get('provinces', {}))} provinces")

    print(f"\nTotal unique provinces across all years: {len(province_yearly)}")

    combined = {}

    for psgc, yearly_data in province_yearly.items():
        if not yearly_data:
            continue

        latest_year = max(yearly_data.keys())
        latest = yearly_data[latest_year]

        scores = [(year, data['score']) for year, data in yearly_data.items() if 'score' in data]
        trend, trend_change = calculate_trend(scores)

        # Calculate average score across all years
        if scores:
            avg_score = sum(s[1] for s in scores) / len(scores)
        else:
            avg_score = None

        # Aggregate observation counts
        total_observations = sum(
            data.get('observationCount', 0) for data in yearly_data.values()
        )

        # Aggregate LGU counts
        total_lgus = max(
            (data.get('lguCount', 0) for data in yearly_data.values()),
            default=0
        )

        combined[psgc] = {
            'name': latest.get('name', 'Unknown'),
            'score': round(avg_score, 2) if avg_score else None,
            'riskLevel': get_risk_level(avg_score),
            'notImplementedPct': latest.get('notImplementedPct'),
            'implementedPct': latest.get('implementedPct'),
            'observationCount': total_observations,
            'lguCount': total_lgus,
            'yearsWithData': len(yearly_data),
            'latestYear': latest_year,
            'trend': trend,
            'trendChange': round(trend_change, 4) if trend_change else None
        }

    output = {
        'description': 'Combined province scores across 2016-2022 with trend analysis',
        'years': list(YEARS),
        'provinces': combined
    }

    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(output, f, separators=(',', ':'))

    print(f"\nWrote {len(combined)} provinces to {OUTPUT_PATH.name}")
    print(f"File size: {OUTPUT_PATH.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
