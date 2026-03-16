"""
Multi-Factor Red Flag Scoring Algorithm v2 for OpenAudit

Combines three factors:
1. Base Rate (40%): Overall % of recommendations NOT implemented
2. Streak Penalty (30%): Consecutive years of poor performance
3. Trend (30%): Is the LGU improving or getting worse?

Final score is 0-100 where:
- 0-20: Excellent compliance
- 21-40: Good compliance
- 41-60: Moderate issues
- 61-80: Significant problems
- 81-100: Critical - endemic non-compliance
"""

import json
import math
from pathlib import Path
from collections import defaultdict
from typing import Any

PROJECT_ROOT = Path(__file__).parent.parent.parent
DATA_DIR = PROJECT_ROOT / "scripts" / "data"
OBSERVATIONS_PATH = DATA_DIR / "observations.json"
LGU_MAPPING_PATH = DATA_DIR / "lgu_mapping.json"
SCORES_OUTPUT_PATH = DATA_DIR / "scores_v2.json"


def calculate_base_rate(observations: list[dict]) -> dict:
    """
    Calculate the overall non-implementation rate.

    Returns dict with:
    - total: total observations
    - not_implemented: count of NOT_IMPLEMENTED
    - partially: count of PARTIALLY_IMPLEMENTED
    - implemented: count of IMPLEMENTED
    - rate: weighted non-compliance rate (NOT=1.0, PARTIAL=0.5)
    """
    if not observations:
        return {"total": 0, "not_implemented": 0, "partially": 0, "implemented": 0, "rate": 0}

    not_impl = 0
    partial = 0
    implemented = 0
    unknown = 0

    for obs in observations:
        status = obs.get("status", "UNKNOWN")
        if status == "NOT_IMPLEMENTED":
            not_impl += 1
        elif status == "PARTIALLY_IMPLEMENTED":
            partial += 1
        elif status == "IMPLEMENTED":
            implemented += 1
        else:
            unknown += 1

    # Only count observations with known status
    known_total = not_impl + partial + implemented
    if known_total == 0:
        return {"total": len(observations), "not_implemented": 0, "partially": 0, "implemented": 0, "rate": 0}

    # Weighted rate: NOT_IMPLEMENTED = 1.0, PARTIALLY = 0.5, IMPLEMENTED = 0
    weighted_non_compliance = not_impl + (partial * 0.5)
    rate = weighted_non_compliance / known_total

    return {
        "total": len(observations),
        "known_total": known_total,
        "not_implemented": not_impl,
        "partially": partial,
        "implemented": implemented,
        "unknown": unknown,
        "rate": round(rate, 4)
    }


def calculate_streak_penalty(observations: list[dict]) -> dict:
    """
    Calculate streak-based penalty for consecutive bad years.

    A "bad year" = non-compliance rate > 40% (weighted)

    Returns:
    - max_streak: longest consecutive bad years
    - current_streak: ongoing streak (if latest year is bad)
    - penalty: 0-100 score component
    """
    if not observations:
        return {"max_streak": 0, "current_streak": 0, "penalty": 0, "years_data": {}}

    # Group by year
    by_year = defaultdict(list)
    for obs in observations:
        year = obs.get("year")
        if year:
            by_year[year].append(obs)

    if not by_year:
        return {"max_streak": 0, "current_streak": 0, "penalty": 0, "years_data": {}}

    # Calculate per-year rates
    years_data = {}
    bad_years = set()

    for year in sorted(by_year.keys()):
        year_obs = by_year[year]
        stats = calculate_base_rate(year_obs)
        years_data[year] = {
            "total": stats["total"],
            "rate": stats["rate"],
            "not_implemented": stats["not_implemented"],
            "partially": stats["partially"],
            "implemented": stats["implemented"]
        }
        # Mark as bad year if rate > 40%
        if stats["rate"] > 0.4:
            bad_years.add(year)

    # Calculate streaks
    sorted_years = sorted(by_year.keys())
    max_streak = 0
    current_streak = 0
    temp_streak = 0

    for i, year in enumerate(sorted_years):
        if year in bad_years:
            temp_streak += 1
            max_streak = max(max_streak, temp_streak)
        else:
            temp_streak = 0

    # Check if current streak extends to most recent year
    if sorted_years and sorted_years[-1] in bad_years:
        # Count backwards from end
        current_streak = 0
        for year in reversed(sorted_years):
            if year in bad_years:
                current_streak += 1
            else:
                break

    # Penalty calculation: exponential for longer streaks
    # 1 year = 10, 2 years = 25, 3 years = 45, 4+ years = 70+
    if max_streak == 0:
        penalty = 0
    elif max_streak == 1:
        penalty = 10
    elif max_streak == 2:
        penalty = 25
    elif max_streak == 3:
        penalty = 45
    elif max_streak == 4:
        penalty = 70
    else:
        penalty = min(100, 70 + (max_streak - 4) * 10)

    return {
        "max_streak": max_streak,
        "current_streak": current_streak,
        "bad_years": len(bad_years),
        "total_years": len(sorted_years),
        "penalty": penalty,
        "years_data": years_data
    }


def calculate_trend(years_data: dict) -> dict:
    """
    Calculate if LGU is improving or worsening.

    Compares recent years (2022-2024) vs earlier years (2016-2019).

    Returns:
    - direction: "improving", "worsening", "stable", "insufficient_data"
    - change: percentage point change
    - score: -50 to +50 (negative = improving, positive = worsening)
    """
    if not years_data or len(years_data) < 3:
        return {"direction": "insufficient_data", "change": 0, "score": 0}

    sorted_years = sorted(years_data.keys())

    # Split into early and recent periods
    early_years = [y for y in sorted_years if y <= 2019]
    recent_years = [y for y in sorted_years if y >= 2022]

    if not early_years or not recent_years:
        # Not enough data for comparison
        return {"direction": "insufficient_data", "change": 0, "score": 0}

    # Calculate average rate for each period
    early_rate = sum(years_data[y]["rate"] for y in early_years) / len(early_years)
    recent_rate = sum(years_data[y]["rate"] for y in recent_years) / len(recent_years)

    change = recent_rate - early_rate  # Positive = worsening

    # Determine direction (threshold of 5 percentage points)
    if change < -0.05:
        direction = "improving"
    elif change > 0.05:
        direction = "worsening"
    else:
        direction = "stable"

    # Score: scale change to -50 to +50
    # A 20 percentage point improvement = -50, 20 point worsening = +50
    score = max(-50, min(50, change * 250))

    return {
        "direction": direction,
        "change": round(change, 4),
        "early_rate": round(early_rate, 4),
        "recent_rate": round(recent_rate, 4),
        "score": round(score, 1)
    }


def calculate_composite_score(base_rate: dict, streak: dict, trend: dict) -> dict:
    """
    Combine factors into final 0-100 score.

    Weights:
    - Base rate: 40% (direct measure of non-compliance)
    - Streak: 30% (pattern of sustained problems)
    - Trend: 30% (direction matters for actionability)
    """
    # Base rate component: 0-100 based on non-compliance rate
    # 0% non-compliance = 0, 100% = 100
    base_component = base_rate["rate"] * 100

    # Streak component: already 0-100
    streak_component = streak["penalty"]

    # Trend component: shift from 0 baseline
    # -50 (improving) to +50 (worsening), center at 25
    trend_component = 25 + trend["score"]

    # Weighted combination
    final_score = (
        base_component * 0.40 +
        streak_component * 0.30 +
        trend_component * 0.30
    )

    # Clamp to 0-100
    final_score = max(0, min(100, final_score))

    # Determine risk level
    if final_score >= 80:
        risk_level = "critical"
    elif final_score >= 60:
        risk_level = "high"
    elif final_score >= 40:
        risk_level = "moderate"
    elif final_score >= 20:
        risk_level = "low"
    else:
        risk_level = "minimal"

    return {
        "final_score": round(final_score, 1),
        "risk_level": risk_level,
        "components": {
            "base_rate": round(base_component, 1),
            "streak": round(streak_component, 1),
            "trend": round(trend_component, 1)
        },
        "weights": {
            "base_rate": 0.40,
            "streak": 0.30,
            "trend": 0.30
        }
    }


def calculate_all_scores(observations: list[dict], lgu_mapping: dict) -> dict:
    """Calculate multi-factor scores for all LGUs."""

    # Group observations by PSGC
    by_psgc = defaultdict(list)
    for obs in observations:
        psgc = obs.get("psgc")
        if psgc:
            by_psgc[psgc].append(obs)

    print(f"Found {len(by_psgc)} unique LGUs with observations")

    scores = {}
    for psgc, lgu_obs in by_psgc.items():
        # Calculate each component
        base = calculate_base_rate(lgu_obs)
        streak = calculate_streak_penalty(lgu_obs)
        trend = calculate_trend(streak["years_data"])
        composite = calculate_composite_score(base, streak, trend)

        # Get LGU metadata
        lgu_info = lgu_mapping.get(psgc, {})

        scores[psgc] = {
            "name": lgu_info.get("name", "Unknown"),
            "province_psgc": lgu_info.get("province_psgc", ""),
            "region_psgc": lgu_info.get("adm1_psgc", ""),

            # Final score
            "score": composite["final_score"],
            "risk_level": composite["risk_level"],

            # Component details
            "base_rate": base["rate"],
            "not_implemented_pct": round(base["not_implemented"] / base["known_total"] * 100, 1) if base.get("known_total", 0) > 0 else 0,
            "max_streak": streak["max_streak"],
            "current_streak": streak["current_streak"],
            "trend": trend["direction"],
            "trend_change": trend["change"],

            # Observation counts
            "observation_count": base["total"],
            "implemented": base["implemented"],
            "not_implemented": base["not_implemented"],
            "partially_implemented": base["partially"],

            # Detailed breakdown
            "components": composite["components"],
            "years_data": streak["years_data"]
        }

    return scores


def print_analysis(scores: dict) -> None:
    """Print score distribution and top offenders."""

    print("\n" + "="*60)
    print("SCORE DISTRIBUTION")
    print("="*60)

    risk_counts = defaultdict(int)
    for data in scores.values():
        risk_counts[data["risk_level"]] += 1

    total = len(scores)
    for level in ["critical", "high", "moderate", "low", "minimal"]:
        count = risk_counts[level]
        pct = count / total * 100 if total > 0 else 0
        bar = "█" * int(pct / 2)
        print(f"{level:>10}: {bar} {count:>4} ({pct:.1f}%)")

    print("\n" + "="*60)
    print("TOP 15 WORST OFFENDERS")
    print("="*60)

    sorted_scores = sorted(scores.items(), key=lambda x: x[1]["score"], reverse=True)

    print(f"{'Rank':<5} {'Score':<7} {'Risk':<10} {'LGU Name':<30} {'Rate':<8} {'Streak':<8} {'Trend':<12}")
    print("-" * 90)

    for i, (psgc, data) in enumerate(sorted_scores[:15], 1):
        name = data["name"][:28]
        print(f"{i:<5} {data['score']:<7.1f} {data['risk_level']:<10} {name:<30} {data['base_rate']*100:<7.1f}% {data['max_streak']:<8} {data['trend']:<12}")

    print("\n" + "="*60)
    print("TOP 10 MOST IMPROVED")
    print("="*60)

    improving = [(p, d) for p, d in scores.items() if d["trend"] == "improving"]
    improving.sort(key=lambda x: x[1]["trend_change"])

    for i, (psgc, data) in enumerate(improving[:10], 1):
        name = data["name"][:28]
        change = data["trend_change"] * 100
        print(f"{i:<5} {name:<30} {change:+.1f}pp improvement")


def main():
    print("Loading observations...")
    with open(OBSERVATIONS_PATH, "r", encoding="utf-8") as f:
        observations = json.load(f)
    print(f"Loaded {len(observations):,} observations")

    print("\nLoading LGU mapping...")
    with open(LGU_MAPPING_PATH, "r", encoding="utf-8") as f:
        lgu_mapping = json.load(f)
    print(f"Loaded {len(lgu_mapping):,} LGU mappings")

    print("\nCalculating multi-factor scores...")
    scores = calculate_all_scores(observations, lgu_mapping)
    print(f"Scored {len(scores):,} LGUs")

    print_analysis(scores)

    print(f"\nWriting scores to {SCORES_OUTPUT_PATH}...")
    with open(SCORES_OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(scores, f, indent=2, ensure_ascii=False)

    print("Done!")


if __name__ == "__main__":
    main()
