"""
Streak-Based Red Flag Scoring Algorithm for OpenAudit

This module implements the scoring methodology for identifying LGUs with endemic
non-compliance patterns. The core insight is that consecutive years of non-implementation
indicate systemic issues (potential corruption), not isolated failures.

Scoring methodology:
- Streak = consecutive years where >50% of recommendations are not implemented
- Longer streaks receive exponentially higher penalties
- Scores are normalized by LGU observation count to prevent large city bias

Output: scripts/data/scores.json with per-LGU scoring data
"""

import json
import math
from pathlib import Path
from collections import defaultdict
from typing import Any


# Project paths
PROJECT_ROOT = Path(__file__).parent.parent.parent
DATA_DIR = PROJECT_ROOT / "scripts" / "data"
OBSERVATIONS_PATH = DATA_DIR / "observations.json"
LGU_MAPPING_PATH = DATA_DIR / "lgu_mapping.json"
SCORES_OUTPUT_PATH = DATA_DIR / "scores.json"


def streak_to_points(streak: int) -> int:
    """
    Convert a streak length to penalty points.

    Scoring rationale:
    - 0 years: No issue = 0 points
    - 1 year: Isolated failure, could be transition = 1 point
    - 2 years: Emerging pattern = 3 points
    - 3 years: Endemic issue = 6 points
    - 4+ years: Severe systemic problem = 6 + (streak-3)*10 points

    Args:
        streak: Number of consecutive years with majority non-implementation

    Returns:
        Penalty points for this streak
    """
    if streak == 0:
        return 0
    if streak == 1:
        return 1  # isolated failure
    if streak == 2:
        return 3  # emerging pattern
    if streak == 3:
        return 6  # endemic issue
    return 6 + (streak - 3) * 10  # severe: 4+ years


def calculate_streak_score(observations: list[dict]) -> dict[str, Any]:
    """
    Calculate red flag score for a set of observations from one LGU.

    Args:
        observations: List of observation dicts with 'year' and 'status' keys

    Returns:
        Dict containing:
        - total_score: Sum of streak points
        - max_streak: Longest consecutive failure streak
        - current_streak: Current ongoing streak (if any)
        - observation_count: Total observations
        - years_data: Per-year breakdown {year: {total, not_implemented, rate}}
    """
    if not observations:
        return {
            "total_score": 0,
            "max_streak": 0,
            "current_streak": 0,
            "observation_count": 0,
            "years_data": {}
        }

    # Group observations by year
    by_year: dict[int, list[dict]] = defaultdict(list)
    for obs in observations:
        year = obs.get("year")
        if year:
            by_year[year].append(obs)

    if not by_year:
        return {
            "total_score": 0,
            "max_streak": 0,
            "current_streak": 0,
            "observation_count": len(observations),
            "years_data": {}
        }

    # Calculate per-year non-implementation rates
    years_data = {}
    failing_years = set()  # Years where majority not implemented

    for year, year_obs in sorted(by_year.items()):
        total = len(year_obs)
        not_impl = sum(1 for o in year_obs if o.get("status") == "NOT_IMPLEMENTED")
        rate = not_impl / total if total > 0 else 0

        years_data[year] = {
            "total": total,
            "not_implemented": not_impl,
            "rate": round(rate, 3)
        }

        # Mark as failing year if majority not implemented
        if rate > 0.5:
            failing_years.add(year)

    # Calculate streaks from chronologically sorted years
    sorted_years = sorted(by_year.keys())
    max_streak = 0
    current_streak = 0
    total_score = 0
    streak_start = None

    for i, year in enumerate(sorted_years):
        if year in failing_years:
            if streak_start is None:
                streak_start = year
                current_streak = 1
            else:
                # Check if consecutive (allow for missing years in data)
                prev_year = sorted_years[i - 1]
                if year - prev_year <= 1:  # Consecutive or direct follow
                    current_streak += 1
                else:
                    # Gap in years - end current streak, start new one
                    total_score += streak_to_points(current_streak)
                    max_streak = max(max_streak, current_streak)
                    current_streak = 1
                    streak_start = year
        else:
            # Non-failing year - end any current streak
            if current_streak > 0:
                total_score += streak_to_points(current_streak)
                max_streak = max(max_streak, current_streak)
            current_streak = 0
            streak_start = None

    # Handle streak that extends to current/last year
    if current_streak > 0:
        total_score += streak_to_points(current_streak)
        max_streak = max(max_streak, current_streak)
        # Check if streak is "current" (includes most recent data year)
        # Most recent data year could be 2024 or latest in dataset
        latest_year = max(sorted_years)
        if latest_year in failing_years:
            # Streak is current (ongoing)
            final_current_streak = current_streak
        else:
            final_current_streak = 0
    else:
        final_current_streak = 0

    return {
        "total_score": total_score,
        "max_streak": max_streak,
        "current_streak": final_current_streak,
        "observation_count": len(observations),
        "years_data": years_data
    }


def normalize_score_by_size(raw_score: int, observation_count: int, median_count: float) -> float:
    """
    Apply logarithmic dampening to normalize scores for LGU size.

    Large cities have more observations simply due to more auditors/projects,
    not necessarily worse compliance. This prevents high-volume LGUs from
    dominating the "worst offenders" list unfairly.

    Args:
        raw_score: Streak-based raw score
        observation_count: Number of observations for this LGU
        median_count: Median observation count across all LGUs

    Returns:
        Normalized score (dampened for high-volume LGUs)
    """
    if observation_count <= 0 or median_count <= 0:
        return float(raw_score)

    if observation_count > median_count:
        # Logarithmic dampening for above-median observation counts
        dampening = 1 / (1 + math.log(observation_count / median_count))
        return round(raw_score * dampening, 2)
    else:
        # No dampening for at-or-below median
        return float(raw_score)


def calculate_all_scores(observations: list[dict], lgu_mapping: dict) -> dict[str, dict]:
    """
    Calculate scores for all LGUs in the dataset.

    Args:
        observations: All observations from observations.json
        lgu_mapping: LGU mapping from lgu_mapping.json

    Returns:
        Dict mapping PSGC code -> score data
    """
    # Group observations by PSGC code
    by_psgc: dict[str, list[dict]] = defaultdict(list)
    missing_psgc = 0

    for obs in observations:
        psgc = obs.get("psgc")
        if psgc:
            by_psgc[psgc].append(obs)
        else:
            missing_psgc += 1

    if missing_psgc > 0:
        print(f"Warning: {missing_psgc} observations missing PSGC code")

    # Calculate raw scores for each LGU
    raw_scores = {}
    for psgc, lgu_obs in by_psgc.items():
        score_data = calculate_streak_score(lgu_obs)
        raw_scores[psgc] = score_data

    # Calculate median observation count for normalization
    obs_counts = [s["observation_count"] for s in raw_scores.values() if s["observation_count"] > 0]
    if obs_counts:
        sorted_counts = sorted(obs_counts)
        mid = len(sorted_counts) // 2
        if len(sorted_counts) % 2 == 0:
            median_count = (sorted_counts[mid - 1] + sorted_counts[mid]) / 2
        else:
            median_count = sorted_counts[mid]
    else:
        median_count = 1.0

    print(f"Median observation count: {median_count:.1f}")

    # Apply normalization and add LGU metadata
    final_scores = {}
    for psgc, score_data in raw_scores.items():
        normalized = normalize_score_by_size(
            score_data["total_score"],
            score_data["observation_count"],
            median_count
        )

        # Get LGU name from mapping
        lgu_info = lgu_mapping.get(psgc, {})
        lgu_name = lgu_info.get("name", "Unknown")
        province_psgc = lgu_info.get("province_psgc", "")
        region_psgc = lgu_info.get("adm1_psgc", "")

        final_scores[psgc] = {
            "name": lgu_name,
            "province_psgc": province_psgc,
            "region_psgc": region_psgc,
            "total_score": score_data["total_score"],
            "normalized_score": normalized,
            "max_streak": score_data["max_streak"],
            "current_streak": score_data["current_streak"],
            "observation_count": score_data["observation_count"],
            "years_data": score_data["years_data"]
        }

    return final_scores


def print_score_distribution(scores: dict[str, dict]) -> None:
    """Print histogram of score distribution."""
    print("\n--- Score Distribution ---")

    # Bucket by score ranges
    buckets = {
        "0": 0,
        "1-5": 0,
        "6-10": 0,
        "11-20": 0,
        "21-50": 0,
        "51-100": 0,
        ">100": 0
    }

    for psgc, data in scores.items():
        score = data["total_score"]
        if score == 0:
            buckets["0"] += 1
        elif score <= 5:
            buckets["1-5"] += 1
        elif score <= 10:
            buckets["6-10"] += 1
        elif score <= 20:
            buckets["11-20"] += 1
        elif score <= 50:
            buckets["21-50"] += 1
        elif score <= 100:
            buckets["51-100"] += 1
        else:
            buckets[">100"] += 1

    max_count = max(buckets.values()) if buckets else 1
    for bucket, count in buckets.items():
        bar_len = int(40 * count / max_count) if max_count > 0 else 0
        bar = "#" * bar_len
        print(f"{bucket:>8}: {bar} ({count})")


def print_top_offenders(scores: dict[str, dict], top_n: int = 10) -> None:
    """Print the worst offending LGUs."""
    print("\n--- Top Offenders (Worst Compliance) ---")

    # Sort by total_score descending
    sorted_scores = sorted(
        scores.items(),
        key=lambda x: x[1]["total_score"],
        reverse=True
    )

    print(f"{'Rank':<5} {'PSGC':<12} {'LGU Name':<30} {'Score':<8} {'Max Streak':<12} {'Observations':<12}")
    print("-" * 85)

    for i, (psgc, data) in enumerate(sorted_scores[:top_n], 1):
        name = data["name"][:28]  # Truncate long names
        print(f"{i:<5} {psgc:<12} {name:<30} {data['total_score']:<8} {data['max_streak']:<12} {data['observation_count']:<12}")


def main():
    """Main execution for testing and generating scores."""
    print("Loading observations...")
    with open(OBSERVATIONS_PATH, "r", encoding="utf-8") as f:
        observations = json.load(f)
    print(f"Loaded {len(observations):,} observations")

    print("\nLoading LGU mapping...")
    with open(LGU_MAPPING_PATH, "r", encoding="utf-8") as f:
        lgu_mapping = json.load(f)
    print(f"Loaded {len(lgu_mapping):,} LGU mappings")

    print("\nCalculating scores...")
    scores = calculate_all_scores(observations, lgu_mapping)
    print(f"Scored {len(scores):,} LGUs")

    # Print analysis
    print_top_offenders(scores)
    print_score_distribution(scores)

    # Output to JSON
    print(f"\nWriting scores to {SCORES_OUTPUT_PATH}...")
    with open(SCORES_OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(scores, f, indent=2, ensure_ascii=False)

    print("Done!")


if __name__ == "__main__":
    main()
