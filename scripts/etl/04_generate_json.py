"""
Browser-Ready JSON Generator for OpenAudit

This module generates the final JSON files for the website frontend.
Files are organized by geographic hierarchy for progressive loading:

- public/data/regions.json - Region summary with scores
- public/data/provinces/{region_psgc}.json - Provinces by region
- public/data/lgus/{province_psgc}.json - LGUs by province
- public/data/findings/{lgu_psgc}.json - Audit findings by LGU

All codes are PSGC (Philippine Standard Geographic Code) to enable
direct joins with TopoJSON map boundaries.
"""

import json
import os
from datetime import date
from pathlib import Path
from collections import defaultdict
from typing import Any


# Project paths
PROJECT_ROOT = Path(__file__).parent.parent.parent
DATA_DIR = PROJECT_ROOT / "scripts" / "data"
GEO_DIR = PROJECT_ROOT / "public" / "geo"
OUTPUT_DIR = PROJECT_ROOT / "public" / "data"

# Input files
OBSERVATIONS_PATH = DATA_DIR / "observations.json"
LGU_MAPPING_PATH = DATA_DIR / "lgu_mapping.json"
SCORES_PATH = DATA_DIR / "scores.json"

# TopoJSON files for geographic metadata
REGIONS_TOPO_PATH = GEO_DIR / "regions.topo.json"
PROVINCES_TOPO_PATH = GEO_DIR / "provinces.topo.json"
LGUS_TOPO_PATH = GEO_DIR / "lgus.topo.json"


def load_topo_features(path: Path) -> dict[int | str, dict]:
    """Load TopoJSON and extract features as dict keyed by PSGC."""
    with open(path, "r", encoding="utf-8") as f:
        topo = json.load(f)

    geom_name = list(topo["objects"].keys())[0]
    features = topo["objects"][geom_name]["geometries"]

    result = {}
    for feat in features:
        props = feat.get("properties", {})
        psgc = props.get("psgc") or props.get("id")
        if psgc:
            # Convert to string for consistent keys
            result[str(psgc)] = props
    return result


def load_all_data() -> tuple[list, dict, dict, dict, dict, dict]:
    """Load all input data files and TopoJSON features."""
    print("Loading data files...")

    with open(OBSERVATIONS_PATH, "r", encoding="utf-8") as f:
        observations = json.load(f)
    print(f"  Observations: {len(observations):,}")

    with open(LGU_MAPPING_PATH, "r", encoding="utf-8") as f:
        lgu_mapping = json.load(f)
    print(f"  LGU Mapping: {len(lgu_mapping):,}")

    with open(SCORES_PATH, "r", encoding="utf-8") as f:
        scores = json.load(f)
    print(f"  Scores: {len(scores):,}")

    print("Loading TopoJSON features...")
    regions_topo = load_topo_features(REGIONS_TOPO_PATH)
    print(f"  Regions: {len(regions_topo)}")

    provinces_topo = load_topo_features(PROVINCES_TOPO_PATH)
    print(f"  Provinces: {len(provinces_topo)}")

    lgus_topo = load_topo_features(LGUS_TOPO_PATH)
    print(f"  LGUs: {len(lgus_topo)}")

    return observations, lgu_mapping, scores, regions_topo, provinces_topo, lgus_topo


def build_region_name_map(provinces_topo: dict) -> dict[str, str]:
    """Build region PSGC -> name mapping from province TopoJSON."""
    # Provinces have region_psgc, we need to derive region names
    # Use standard Philippine region names
    region_names = {
        "100000000": "Region I (Ilocos Region)",
        "200000000": "CAR (Cordillera Administrative Region)",
        "300000000": "Region II (Cagayan Valley)",
        "400000000": "Region III (Central Luzon)",
        "500000000": "Region IV-A (CALABARZON)",
        "1700000000": "MIMAROPA",
        "600000000": "Region V (Bicol Region)",
        "700000000": "Region VI (Western Visayas)",
        "800000000": "Region VII (Central Visayas)",
        "900000000": "Region VIII (Eastern Visayas)",
        "1000000000": "Region IX (Zamboanga Peninsula)",
        "1100000000": "Region X (Northern Mindanao)",
        "1200000000": "Region XI (Davao Region)",
        "1300000000": "NCR (National Capital Region)",
        "1400000000": "Region XII (SOCCSKSARGEN)",
        "1600000000": "Region XIII (Caraga)",
        "1900000000": "BARMM",
    }
    return region_names


def build_hierarchy(
    lgu_mapping: dict,
    scores: dict,
    regions_topo: dict,
    provinces_topo: dict,
    lgus_topo: dict,
) -> tuple[dict, dict, dict]:
    """
    Build geographic hierarchy from mapping and TopoJSON.

    Returns:
        - regions: {psgc: {name, provinces: {psgc: {name, lgus: [psgc]}}}}
        - province_details: {psgc: {name, region_psgc, region_name}}
        - lgu_details: {psgc: {name, province_psgc, region_psgc, score_data}}
    """
    region_names = build_region_name_map(provinces_topo)

    # Build region -> provinces -> LGUs hierarchy
    regions: dict[str, dict] = {}
    province_details: dict[str, dict] = {}
    lgu_details: dict[str, dict] = {}

    # Initialize regions from TopoJSON
    for region_psgc in regions_topo.keys():
        regions[region_psgc] = {
            "name": region_names.get(region_psgc, f"Region {region_psgc}"),
            "provinces": {},
        }

    # Add provinces from TopoJSON
    for prov_psgc, props in provinces_topo.items():
        region_psgc = str(props.get("region_psgc", ""))
        prov_name = props.get("name", f"Province {prov_psgc}")

        if region_psgc in regions:
            regions[region_psgc]["provinces"][prov_psgc] = {
                "name": prov_name,
                "lgus": [],
            }

        province_details[prov_psgc] = {
            "name": prov_name,
            "region_psgc": region_psgc,
            "region_name": regions.get(region_psgc, {}).get("name", ""),
        }

    # Add LGUs from TopoJSON and scores
    for lgu_psgc, props in lgus_topo.items():
        prov_psgc = str(props.get("province_psgc", ""))
        region_psgc = str(props.get("adm1_psgc", ""))
        lgu_name = props.get("name", f"LGU {lgu_psgc}")

        # Add to province's LGU list
        if region_psgc in regions and prov_psgc in regions[region_psgc]["provinces"]:
            regions[region_psgc]["provinces"][prov_psgc]["lgus"].append(lgu_psgc)

        # Get score data
        score_data = scores.get(lgu_psgc, {
            "total_score": 0,
            "normalized_score": 0.0,
            "max_streak": 0,
            "current_streak": 0,
            "observation_count": 0,
            "years_data": {}
        })

        lgu_details[lgu_psgc] = {
            "name": lgu_name,
            "province_psgc": prov_psgc,
            "province_name": province_details.get(prov_psgc, {}).get("name", ""),
            "region_psgc": region_psgc,
            "region_name": regions.get(region_psgc, {}).get("name", ""),
            "score": score_data.get("total_score", 0),
            "normalized_score": score_data.get("normalized_score", 0.0),
            "max_streak": score_data.get("max_streak", 0),
            "current_streak": score_data.get("current_streak", 0),
            "observation_count": score_data.get("observation_count", 0),
            "years_data": score_data.get("years_data", {}),
        }

    return regions, province_details, lgu_details


def generate_regions_json(
    regions: dict,
    lgu_details: dict,
    output_dir: Path,
) -> None:
    """Generate regions.json with aggregated scores."""
    region_list = []

    for region_psgc, region_data in sorted(regions.items()):
        # Collect all LGU scores in this region
        region_scores = []
        lgu_count = 0

        for prov_data in region_data["provinces"].values():
            for lgu_psgc in prov_data["lgus"]:
                lgu = lgu_details.get(lgu_psgc, {})
                score = lgu.get("score", 0)
                region_scores.append(score)
                lgu_count += 1

        # Calculate aggregated score (sum of all LGU scores)
        total_score = sum(region_scores)
        worst_score = max(region_scores) if region_scores else 0
        avg_score = total_score / len(region_scores) if region_scores else 0

        region_list.append({
            "code": region_psgc,
            "name": region_data["name"],
            "score": round(avg_score, 2),  # Average per LGU
            "totalScore": total_score,     # Sum for ranking
            "lguCount": lgu_count,
            "worstScore": worst_score,
            "provinceCount": len(region_data["provinces"]),
        })

    # Sort by totalScore descending (worst offenders first)
    region_list.sort(key=lambda x: x["totalScore"], reverse=True)

    output = {
        "updated": date.today().isoformat(),
        "regions": region_list,
    }

    output_path = output_dir / "regions.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"Generated: {output_path} ({len(region_list)} regions)")


def generate_provinces_json(
    regions: dict,
    lgu_details: dict,
    output_dir: Path,
) -> None:
    """Generate provinces/{region_psgc}.json files."""
    provinces_dir = output_dir / "provinces"
    provinces_dir.mkdir(parents=True, exist_ok=True)

    files_created = 0

    for region_psgc, region_data in regions.items():
        province_list = []

        for prov_psgc, prov_data in sorted(region_data["provinces"].items()):
            # Collect LGU scores in this province
            prov_scores = []
            for lgu_psgc in prov_data["lgus"]:
                lgu = lgu_details.get(lgu_psgc, {})
                score = lgu.get("score", 0)
                prov_scores.append(score)

            total_score = sum(prov_scores)
            avg_score = total_score / len(prov_scores) if prov_scores else 0

            province_list.append({
                "code": prov_psgc,
                "name": prov_data["name"],
                "score": round(avg_score, 2),
                "totalScore": total_score,
                "lguCount": len(prov_data["lgus"]),
            })

        # Sort by totalScore descending
        province_list.sort(key=lambda x: x["totalScore"], reverse=True)

        output = {
            "regionCode": region_psgc,
            "regionName": region_data["name"],
            "provinces": province_list,
        }

        output_path = provinces_dir / f"{region_psgc}.json"
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(output, f, indent=2, ensure_ascii=False)

        files_created += 1

    print(f"Generated: {provinces_dir}/ ({files_created} files)")


def generate_lgus_json(
    regions: dict,
    lgu_details: dict,
    output_dir: Path,
) -> None:
    """Generate lgus/{province_psgc}.json files."""
    lgus_dir = output_dir / "lgus"
    lgus_dir.mkdir(parents=True, exist_ok=True)

    files_created = 0

    for region_psgc, region_data in regions.items():
        for prov_psgc, prov_data in region_data["provinces"].items():
            lgu_list = []

            for lgu_psgc in prov_data["lgus"]:
                lgu = lgu_details.get(lgu_psgc, {})

                lgu_list.append({
                    "code": lgu_psgc,
                    "name": lgu.get("name", f"LGU {lgu_psgc}"),
                    "score": lgu.get("score", 0),
                    "normalizedScore": lgu.get("normalized_score", 0.0),
                    "maxStreak": lgu.get("max_streak", 0),
                    "observationCount": lgu.get("observation_count", 0),
                })

            # Sort by score descending
            lgu_list.sort(key=lambda x: x["score"], reverse=True)

            # Get province and region names
            prov_name = prov_data["name"]
            region_name = region_data["name"]

            output = {
                "provinceCode": prov_psgc,
                "provinceName": prov_name,
                "regionCode": region_psgc,
                "regionName": region_name,
                "lgus": lgu_list,
            }

            output_path = lgus_dir / f"{prov_psgc}.json"
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(output, f, indent=2, ensure_ascii=False)

            files_created += 1

    print(f"Generated: {lgus_dir}/ ({files_created} files)")


def generate_findings_json(
    observations: list,
    lgu_details: dict,
    output_dir: Path,
) -> None:
    """Generate findings/{lgu_psgc}.json files."""
    findings_dir = output_dir / "findings"
    findings_dir.mkdir(parents=True, exist_ok=True)

    # Group observations by LGU PSGC
    by_lgu: dict[str, list] = defaultdict(list)
    for obs in observations:
        psgc = obs.get("psgc")
        if psgc:
            by_lgu[psgc].append(obs)

    files_created = 0
    total_observations = 0

    for lgu_psgc, lgu_obs in by_lgu.items():
        lgu = lgu_details.get(lgu_psgc, {})

        # Sort observations: by year DESC, then NOT_IMPLEMENTED first
        def sort_key(obs):
            year = obs.get("year", 0)
            status = obs.get("status", "")
            # NOT_IMPLEMENTED = 0, others = 1 (for ascending sort to put NOT_IMPLEMENTED first)
            status_order = 0 if status == "NOT_IMPLEMENTED" else 1
            return (-year, status_order)

        sorted_obs = sorted(lgu_obs, key=sort_key)

        # Format observations for output
        formatted_obs = []
        for obs in sorted_obs:
            formatted_obs.append({
                "id": obs.get("id", ""),
                "year": obs.get("year", 0),
                "recommendation": obs.get("recommendation", ""),
                "managementAction": obs.get("management_action", ""),
                "status": obs.get("status", "UNKNOWN"),
                "reason": obs.get("reason", ""),
            })

        output = {
            "lguCode": lgu_psgc,
            "lguName": lgu.get("name", f"LGU {lgu_psgc}"),
            "province": lgu.get("province_name", ""),
            "region": lgu.get("region_name", ""),
            "scores": {
                "total": lgu.get("score", 0),
                "normalized": lgu.get("normalized_score", 0.0),
                "maxStreak": lgu.get("max_streak", 0),
                "currentStreak": lgu.get("current_streak", 0),
            },
            "observations": formatted_obs,
        }

        output_path = findings_dir / f"{lgu_psgc}.json"
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(output, f, indent=2, ensure_ascii=False)

        files_created += 1
        total_observations += len(formatted_obs)

    print(f"Generated: {findings_dir}/ ({files_created} files, {total_observations:,} observations)")


def print_size_report(output_dir: Path) -> None:
    """Print size report for generated files."""
    print("\n--- Size Report ---")

    # Calculate sizes
    total_size = 0
    largest_files = []

    for root, dirs, files in os.walk(output_dir):
        for file in files:
            if file.endswith(".json"):
                path = Path(root) / file
                size = path.stat().st_size
                total_size += size
                largest_files.append((path, size))

    # Sort by size descending
    largest_files.sort(key=lambda x: x[1], reverse=True)

    print(f"Total files: {len(largest_files)}")
    print(f"Total size: {total_size / 1024:.1f} KB ({total_size / 1024 / 1024:.2f} MB)")

    print("\nLargest files (top 5):")
    for path, size in largest_files[:5]:
        rel_path = path.relative_to(output_dir)
        print(f"  {rel_path}: {size / 1024:.1f} KB")

    # Directory breakdown
    print("\nBy directory:")
    for subdir in ["provinces", "lgus", "findings"]:
        subdir_path = output_dir / subdir
        if subdir_path.exists():
            subdir_size = sum(f.stat().st_size for f in subdir_path.glob("*.json"))
            file_count = len(list(subdir_path.glob("*.json")))
            print(f"  {subdir}/: {subdir_size / 1024:.1f} KB ({file_count} files)")


def main():
    """Main execution."""
    # Create output directories
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Load all data
    observations, lgu_mapping, scores, regions_topo, provinces_topo, lgus_topo = load_all_data()

    # Build geographic hierarchy
    print("\nBuilding geographic hierarchy...")
    regions, province_details, lgu_details = build_hierarchy(
        lgu_mapping, scores, regions_topo, provinces_topo, lgus_topo
    )
    print(f"  Regions: {len(regions)}")
    print(f"  Provinces: {len(province_details)}")
    print(f"  LGUs: {len(lgu_details)}")

    # Generate output files
    print("\nGenerating JSON files...")
    generate_regions_json(regions, lgu_details, OUTPUT_DIR)
    generate_provinces_json(regions, lgu_details, OUTPUT_DIR)
    generate_lgus_json(regions, lgu_details, OUTPUT_DIR)
    generate_findings_json(observations, lgu_details, OUTPUT_DIR)

    # Print size report
    print_size_report(OUTPUT_DIR)

    print("\nDone!")


if __name__ == "__main__":
    main()
