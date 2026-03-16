"""
Output Validation for OpenAudit JSON Files

Validates that generated JSON files meet size targets and structure requirements:
1. Total size is documented (compressed size for reference)
2. JSON structure has required fields
3. PSGC codes match between JSON and TopoJSON features
"""

import json
import gzip
import os
from pathlib import Path
from typing import Any


# Project paths
PROJECT_ROOT = Path(__file__).parent.parent.parent
DATA_DIR = PROJECT_ROOT / "public" / "data"
GEO_DIR = PROJECT_ROOT / "public" / "geo"


def get_directory_size(path: Path, compressed: bool = False) -> tuple[int, int]:
    """
    Calculate total size of JSON files in directory.

    Args:
        path: Directory path
        compressed: If True, calculate gzip compressed size

    Returns:
        (uncompressed_bytes, compressed_bytes)
    """
    uncompressed = 0
    compressed_total = 0

    for root, dirs, files in os.walk(path):
        for file in files:
            if file.endswith(".json"):
                file_path = Path(root) / file
                content = file_path.read_bytes()
                uncompressed += len(content)
                if compressed:
                    compressed_total += len(gzip.compress(content))

    return uncompressed, compressed_total


def load_topo_psgc_codes(path: Path) -> set[str]:
    """Load all PSGC codes from TopoJSON file."""
    with open(path, "r", encoding="utf-8") as f:
        topo = json.load(f)

    geom_name = list(topo["objects"].keys())[0]
    features = topo["objects"][geom_name]["geometries"]

    codes = set()
    for feat in features:
        props = feat.get("properties", {})
        psgc = props.get("psgc") or props.get("id")
        if psgc:
            codes.add(str(psgc))
    return codes


def validate_regions_json() -> tuple[bool, list[str]]:
    """Validate regions.json structure."""
    errors = []
    path = DATA_DIR / "regions.json"

    if not path.exists():
        return False, ["regions.json not found"]

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Check required fields
    if "updated" not in data:
        errors.append("Missing 'updated' field")
    if "regions" not in data:
        errors.append("Missing 'regions' field")
        return False, errors

    regions = data["regions"]
    if not regions:
        errors.append("Empty regions array")
        return False, errors

    # Check each region has required fields
    required = ["code", "name", "score", "lguCount", "provinceCount"]
    for i, region in enumerate(regions):
        for field in required:
            if field not in region:
                errors.append(f"Region {i}: missing '{field}' field")

        # Validate code is PSGC format (9-10 digit string)
        code = str(region.get("code", ""))
        if not code.isdigit() or len(code) < 9:
            errors.append(f"Region {i}: invalid PSGC code '{code}'")

    return len(errors) == 0, errors


def validate_province_files() -> tuple[bool, list[str]]:
    """Validate province JSON files."""
    errors = []
    provinces_dir = DATA_DIR / "provinces"

    if not provinces_dir.exists():
        return False, ["provinces/ directory not found"]

    files = list(provinces_dir.glob("*.json"))
    if not files:
        errors.append("No province files found")
        return False, errors

    required = ["code", "name", "score", "lguCount"]
    for file in files:
        with open(file, "r", encoding="utf-8") as f:
            data = json.load(f)

        if "regionCode" not in data or "provinces" not in data:
            errors.append(f"{file.name}: missing regionCode or provinces")
            continue

        for i, prov in enumerate(data["provinces"]):
            for field in required:
                if field not in prov:
                    errors.append(f"{file.name} province {i}: missing '{field}'")

    return len(errors) == 0, errors


def validate_lgu_files() -> tuple[bool, list[str]]:
    """Validate LGU JSON files."""
    errors = []
    lgus_dir = DATA_DIR / "lgus"

    if not lgus_dir.exists():
        return False, ["lgus/ directory not found"]

    files = list(lgus_dir.glob("*.json"))
    if not files:
        errors.append("No LGU files found")
        return False, errors

    # Spot check first 10 files
    required = ["code", "name", "score"]
    for file in files[:10]:
        with open(file, "r", encoding="utf-8") as f:
            data = json.load(f)

        if "provinceCode" not in data or "lgus" not in data:
            errors.append(f"{file.name}: missing provinceCode or lgus")
            continue

        for i, lgu in enumerate(data["lgus"][:5]):  # Check first 5 LGUs
            for field in required:
                if field not in lgu:
                    errors.append(f"{file.name} LGU {i}: missing '{field}'")

    return len(errors) == 0, errors


def validate_findings_files() -> tuple[bool, list[str]]:
    """Validate findings JSON files."""
    errors = []
    findings_dir = DATA_DIR / "findings"

    if not findings_dir.exists():
        return False, ["findings/ directory not found"]

    files = list(findings_dir.glob("*.json"))
    if not files:
        errors.append("No findings files found")
        return False, errors

    # Spot check first 10 files
    required = ["lguCode", "lguName", "scores", "observations"]
    for file in files[:10]:
        with open(file, "r", encoding="utf-8") as f:
            data = json.load(f)

        for field in required:
            if field not in data:
                errors.append(f"{file.name}: missing '{field}'")

        # Check observations structure
        if "observations" in data and data["observations"]:
            obs = data["observations"][0]
            obs_required = ["id", "year", "status"]
            for field in obs_required:
                if field not in obs:
                    errors.append(f"{file.name}: observation missing '{field}'")

    return len(errors) == 0, errors


def validate_psgc_match() -> tuple[bool, float, list[str]]:
    """
    Validate PSGC codes match between JSON output and TopoJSON.

    Validation logic:
    - Regions: All TopoJSON regions must appear in regions.json (100%)
    - Provinces: All TopoJSON provinces must appear in province files (100%)
    - LGUs: All findings LGU codes must be valid (exist in TopoJSON)
            Not all TopoJSON LGUs need findings (only those with observations)

    Returns:
        (passed, match_rate, errors)
    """
    errors = []

    # Load TopoJSON PSGC codes
    regions_topo = load_topo_psgc_codes(GEO_DIR / "regions.topo.json")
    provinces_topo = load_topo_psgc_codes(GEO_DIR / "provinces.topo.json")
    lgus_topo = load_topo_psgc_codes(GEO_DIR / "lgus.topo.json")

    # Load JSON PSGC codes
    with open(DATA_DIR / "regions.json", "r", encoding="utf-8") as f:
        regions_json = {str(r["code"]) for r in json.load(f)["regions"]}

    # Province codes from province files
    provinces_json = set()
    for file in (DATA_DIR / "provinces").glob("*.json"):
        with open(file, "r", encoding="utf-8") as f:
            data = json.load(f)
            for prov in data["provinces"]:
                provinces_json.add(str(prov["code"]))

    # LGU codes from findings files
    lgus_json = set()
    for file in (DATA_DIR / "findings").glob("*.json"):
        with open(file, "r", encoding="utf-8") as f:
            data = json.load(f)
            lgus_json.add(str(data["lguCode"]))

    # Calculate match rates
    # Regions: JSON must cover all TopoJSON
    region_match = len(regions_json & regions_topo) / len(regions_topo) if regions_topo else 0

    # Provinces: JSON must cover all TopoJSON
    province_match = len(provinces_json & provinces_topo) / len(provinces_topo) if provinces_topo else 0

    # LGUs: Findings codes must be valid (exist in TopoJSON)
    # Not all TopoJSON LGUs need findings - only those with observations
    lgu_valid_codes = len(lgus_json & lgus_topo)
    lgu_invalid_codes = len(lgus_json - lgus_topo)
    lgu_validity_rate = lgu_valid_codes / len(lgus_json) if lgus_json else 0
    lgu_coverage_rate = lgu_valid_codes / len(lgus_topo) if lgus_topo else 0

    # Report
    print(f"\nPSGC Code Validation:")
    print(f"  Regions:   {region_match*100:.1f}% coverage ({len(regions_json & regions_topo)}/{len(regions_topo)} TopoJSON regions)")
    print(f"  Provinces: {province_match*100:.1f}% coverage ({len(provinces_json & provinces_topo)}/{len(provinces_topo)} TopoJSON provinces)")
    print(f"  LGUs:")
    print(f"    Valid codes: {lgu_validity_rate*100:.1f}% ({lgu_valid_codes}/{len(lgus_json)} findings have valid PSGC)")
    print(f"    Coverage:    {lgu_coverage_rate*100:.1f}% ({lgu_valid_codes}/{len(lgus_topo)} TopoJSON LGUs have findings)")
    if lgu_invalid_codes > 0:
        invalid = lgus_json - lgus_topo
        print(f"    Invalid codes: {list(invalid)[:5]}{'...' if len(invalid) > 5 else ''}")

    # Report missing codes
    if region_match < 1.0:
        missing = regions_topo - regions_json
        if missing:
            errors.append(f"Missing region codes: {missing}")

    if province_match < 1.0:
        missing = provinces_topo - provinces_json
        if missing and len(missing) <= 10:
            errors.append(f"Missing province codes: {missing}")
        elif missing:
            errors.append(f"Missing {len(missing)} province codes")

    if lgu_invalid_codes > 0:
        errors.append(f"{lgu_invalid_codes} findings have invalid PSGC codes (not in TopoJSON)")

    # Pass criteria:
    # - Regions: 100% coverage
    # - Provinces: 100% coverage
    # - LGUs: 100% validity (all findings codes must be valid)
    # Note: LGU coverage can be <100% since not all LGUs have audit observations
    passed = (region_match >= 1.0 and province_match >= 1.0 and lgu_validity_rate >= 1.0)

    # Overall metric for reporting
    overall_match = (region_match + province_match + lgu_validity_rate) / 3

    return passed, overall_match, errors


def main():
    """Run all validations."""
    print("=" * 60)
    print("OpenAudit JSON Output Validation")
    print("=" * 60)

    all_passed = True
    results = []

    # 1. Size report
    print("\n--- Size Report ---")
    uncompressed, compressed = get_directory_size(DATA_DIR, compressed=True)
    print(f"Total uncompressed: {uncompressed / 1024 / 1024:.1f} MB")
    print(f"Total gzip compressed: {compressed / 1024:.1f} KB ({compressed / 1024 / 1024:.2f} MB)")

    # Progressive loading sizes (excluding findings which are lazy-loaded)
    hierarchy_size = 0
    hierarchy_compressed = 0
    for path in [DATA_DIR / "regions.json"]:
        if path.exists():
            content = path.read_bytes()
            hierarchy_size += len(content)
            hierarchy_compressed += len(gzip.compress(content))

    for subdir in ["provinces", "lgus"]:
        subdir_path = DATA_DIR / subdir
        if subdir_path.exists():
            u, c = get_directory_size(subdir_path, compressed=True)
            hierarchy_size += u
            hierarchy_compressed += c

    print(f"\nHierarchy files (regions + provinces + lgus):")
    print(f"  Uncompressed: {hierarchy_size / 1024:.1f} KB")
    print(f"  Gzip compressed: {hierarchy_compressed / 1024:.1f} KB")

    # 2. Structure validation
    print("\n--- Structure Validation ---")

    # Regions
    passed, errors = validate_regions_json()
    status = "PASS" if passed else "FAIL"
    print(f"regions.json: {status}")
    for err in errors:
        print(f"  - {err}")
    results.append(("regions.json", passed))

    # Provinces
    passed, errors = validate_province_files()
    status = "PASS" if passed else "FAIL"
    print(f"provinces/*.json: {status}")
    for err in errors[:5]:  # Limit error output
        print(f"  - {err}")
    results.append(("provinces", passed))

    # LGUs
    passed, errors = validate_lgu_files()
    status = "PASS" if passed else "FAIL"
    print(f"lgus/*.json: {status}")
    for err in errors[:5]:
        print(f"  - {err}")
    results.append(("lgus", passed))

    # Findings
    passed, errors = validate_findings_files()
    status = "PASS" if passed else "FAIL"
    print(f"findings/*.json: {status}")
    for err in errors[:5]:
        print(f"  - {err}")
    results.append(("findings", passed))

    # 3. PSGC code matching
    print("\n--- PSGC Code Matching ---")
    passed, match_rate, errors = validate_psgc_match()
    status = "PASS" if passed else "FAIL"
    print(f"Overall match rate: {match_rate*100:.1f}% [{status}]")
    for err in errors[:5]:
        print(f"  - {err}")
    results.append(("psgc_match", passed))

    # Summary
    print("\n" + "=" * 60)
    print("VALIDATION SUMMARY")
    print("=" * 60)

    all_passed = all(r[1] for r in results)
    for name, passed in results:
        status = "PASS" if passed else "FAIL"
        print(f"  {name}: {status}")

    print()
    if all_passed:
        print("RESULT: ALL VALIDATIONS PASSED")
        exit(0)
    else:
        print("RESULT: SOME VALIDATIONS FAILED")
        exit(1)


if __name__ == "__main__":
    main()
