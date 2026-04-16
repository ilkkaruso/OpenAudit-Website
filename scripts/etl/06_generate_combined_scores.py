#!/usr/bin/env python3
"""
Generate a combined LGU scores file for the data explorer.
Aggregates data across all years (2016-2022) with trend analysis.
"""

import json
from pathlib import Path
from collections import defaultdict

PROJECT_ROOT = Path(__file__).parent.parent.parent
DATA_DIR = PROJECT_ROOT / "public" / "data"
OUTPUT_PATH = DATA_DIR / "lgu-scores.json"

YEARS = range(2016, 2023)  # 2016-2022


def calculate_trend(scores: list) -> tuple:
    """Calculate trend from list of (year, score) tuples."""
    if len(scores) < 2:
        return 'insufficient_data', 0.0

    # Sort by year
    scores = sorted(scores, key=lambda x: x[0])

    # Simple linear regression for trend
    n = len(scores)
    sum_x = sum(i for i in range(n))
    sum_y = sum(s[1] for s in scores)
    sum_xy = sum(i * s[1] for i, s in enumerate(scores))
    sum_xx = sum(i * i for i in range(n))

    denom = n * sum_xx - sum_x * sum_x
    if denom == 0:
        return 'stable', 0.0

    slope = (n * sum_xy - sum_x * sum_y) / denom

    # Determine trend direction
    if slope < -2:
        return 'improving', slope  # Lower score = better
    elif slope > 2:
        return 'worsening', slope
    else:
        return 'stable', slope


def calculate_streaks(yearly_scores: dict) -> tuple:
    """Calculate max and current streak of high-risk years."""
    if not yearly_scores:
        return 0, 0

    years = sorted(yearly_scores.keys())
    max_streak = 0
    current_streak = 0
    streak = 0

    for year in years:
        score = yearly_scores[year]
        if score >= 40:  # Moderate or higher risk
            streak += 1
            max_streak = max(max_streak, streak)
        else:
            streak = 0

    # Current streak is streak at the end
    current_streak = streak

    return max_streak, current_streak


def main():
    print("Loading per-year score files...")

    # Collect all LGU data across years
    lgu_yearly = defaultdict(dict)  # psgc -> {year: score_data}

    for year in YEARS:
        score_file = DATA_DIR / f"scores-{year}.json"
        if not score_file.exists():
            print(f"  Warning: {score_file.name} not found")
            continue

        with open(score_file, 'r', encoding='utf-8') as f:
            data = json.load(f)

        for psgc, score_data in data.get('lgus', {}).items():
            lgu_yearly[psgc][year] = score_data

        print(f"  {year}: {len(data.get('lgus', {}))} LGUs")

    print(f"\nTotal unique LGUs across all years: {len(lgu_yearly)}")

    # Generate combined scores with aggregated metrics
    combined = {}

    for psgc, yearly_data in lgu_yearly.items():
        if not yearly_data:
            continue

        # Get latest year's data as base
        latest_year = max(yearly_data.keys())
        latest = yearly_data[latest_year]

        # Collect scores for trend analysis
        scores = [(year, data['score']) for year, data in yearly_data.items() if 'score' in data]

        # Calculate trend
        trend, trend_change = calculate_trend(scores)

        # Calculate streaks
        yearly_scores = {year: data['score'] for year, data in yearly_data.items() if 'score' in data}
        max_streak, current_streak = calculate_streaks(yearly_scores)

        # Aggregate observation counts
        total_observations = sum(
            data.get('observationCount', 0) for data in yearly_data.values()
        )

        # Calculate base rate (average score across all years)
        if scores:
            base_rate = sum(s[1] for s in scores) / len(scores) / 100
        else:
            base_rate = None

        # Count implementation statuses (estimate from percentages)
        implemented = 0
        not_implemented = 0
        partially_implemented = 0

        for year_data in yearly_data.values():
            obs = year_data.get('observationCount', 0)
            impl_pct = year_data.get('implementedPct', 0)
            not_impl_pct = year_data.get('notImplementedPct', 0)
            partial_pct = 100 - impl_pct - not_impl_pct

            implemented += int(obs * impl_pct / 100)
            not_implemented += int(obs * not_impl_pct / 100)
            partially_implemented += int(obs * partial_pct / 100)

        combined[psgc] = {
            'name': latest.get('name', 'Unknown'),
            'province': latest.get('province', ''),
            'score': latest.get('score'),
            'riskLevel': latest.get('riskLevel'),
            'notImplementedPct': latest.get('notImplementedPct'),
            'implementedPct': latest.get('implementedPct'),
            'observationCount': total_observations,
            'yearsWithData': len(yearly_data),
            'latestYear': latest_year,
            'trend': trend,
            'trendChange': round(trend_change, 4) if trend_change else None,
            'maxStreak': max_streak,
            'currentStreak': current_streak,
            'baseRate': round(base_rate, 4) if base_rate else None,
            'implemented': implemented,
            'not_implemented': not_implemented,
            'partially_implemented': partially_implemented
        }

    # Write combined file
    output = {
        'description': 'Combined LGU scores across 2016-2022 with trend analysis',
        'generatedAt': str(Path(__file__).stat().st_mtime),
        'years': list(YEARS),
        'lgus': combined
    }

    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(output, f, separators=(',', ':'))

    print(f"\nWrote {len(combined)} LGUs to {OUTPUT_PATH.name}")
    print(f"File size: {OUTPUT_PATH.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
