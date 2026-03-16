---
phase: 01-data-foundation
plan: 04
subsystem: data-pipeline
tags: [python, json, scoring, etl, psgc]

# Dependency graph
requires:
  - phase: 01-03
    provides: observations.json with 388,197 audit observations
  - phase: 01-01
    provides: lgu_mapping.json with PSGC codes
  - phase: 01-02
    provides: TopoJSON boundary files with PSGC feature IDs
provides:
  - Streak-based red flag scoring algorithm
  - Browser-ready JSON files organized by geographic hierarchy
  - Per-LGU findings files for lazy loading
  - Validation script for output verification
affects: [02-map, 02-tables, frontend]

# Tech tracking
tech-stack:
  added: [gzip]
  patterns: [streak-scoring, geographic-hierarchy, lazy-loading]

key-files:
  created:
    - scripts/etl/03_calculate_scores.py
    - scripts/etl/04_generate_json.py
    - scripts/etl/validate_output.py
    - scripts/data/scores.json
    - public/data/regions.json
    - public/data/provinces/
    - public/data/lgus/
    - public/data/findings/
  modified: []

key-decisions:
  - "Streak scoring with exponential penalty: 1yr=1pt, 2yr=3pt, 3yr=6pt, 4+yr=6+(n-3)*10pt"
  - "Log dampening for normalization: prevents large cities dominating worst offenders"
  - "Geographic hierarchy: regions -> provinces -> lgus -> findings for progressive loading"
  - "83.5% LGU coverage acceptable: remaining 267 LGUs have no observations in dataset"

patterns-established:
  - "PSGC codes as universal identifiers across all JSON and TopoJSON files"
  - "Lazy loading pattern: hierarchy files small (44KB), findings loaded on demand"
  - "Sorted by score descending (worst offenders first) throughout"

# Metrics
duration: 7min
completed: 2026-03-16
---

# Phase 01 Plan 04: Score Calculation & JSON Generation Summary

**Streak-based red flag scoring with geographic hierarchy JSON output for progressive loading**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-16T04:02:56Z
- **Completed:** 2026-03-16T04:10:04Z
- **Tasks:** 3
- **Files created:** 1,460+ (scripts + JSON hierarchy)

## Accomplishments

- Implemented streak-based scoring algorithm that penalizes consecutive years of non-compliance
- Generated browser-ready JSON files organized by region -> province -> LGU hierarchy
- Created 1,351 per-LGU findings files for lazy loading (388,197 total observations)
- Validated 100% PSGC code integrity between JSON and TopoJSON

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement Streak-Based Scoring** - `fa74827` (feat)
2. **Task 2: Generate Browser-Ready JSON** - `efecb36`, `c273237` (feat)
3. **Task 3: Validate Output** - `938e7ef` (feat)

## Files Created/Modified

**Scripts:**
- `scripts/etl/03_calculate_scores.py` - Streak scoring with normalization
- `scripts/etl/04_generate_json.py` - Geographic hierarchy JSON generation
- `scripts/etl/validate_output.py` - Output validation and size reporting
- `scripts/data/scores.json` - Intermediate scoring data (1,351 LGUs)

**JSON Output:**
- `public/data/regions.json` - 17 regions (3.4KB)
- `public/data/provinces/` - 17 files by region PSGC (13KB total)
- `public/data/lgus/` - 88 files by province PSGC (277KB total)
- `public/data/findings/` - 1,351 files by LGU PSGC (275MB total)

## Decisions Made

1. **Streak scoring formula**: Exponential penalty rewards sustained compliance efforts. Single year failures (1pt) vs. 3-year endemic patterns (6pt) vs. 4+ year systemic issues (16+ pts)

2. **Log dampening normalization**: Large cities with more observations don't automatically rank as worst offenders. Formula: `score * 1/(1 + log(obs_count/median))`

3. **83.5% LGU coverage is correct**: Only 1,351 of 1,618 TopoJSON LGUs have audit observations in the 2016-2024 dataset. The remaining 267 genuinely have no COA findings to display.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None - all processing completed successfully.

## Size Report

| Category | Uncompressed | Gzip Compressed |
|----------|--------------|-----------------|
| Hierarchy (regions + provinces + lgus) | 293 KB | 44 KB |
| Findings (per-LGU) | 275 MB | 49 MB |
| **Total** | 276 MB | 49 MB |

The hierarchy files (44KB compressed) are well under the 500KB target for initial page load. Findings files are loaded lazily when user drills into specific LGU.

## Top Scoring LGUs (Worst Offenders)

| Rank | LGU | Score | Max Streak |
|------|-----|-------|------------|
| 1 | Consolacion (Cebu) | 6 | 3 years |
| 2 | Mayorga (Leyte) | 6 | 3 years |
| 3 | Linapacan (Palawan) | 4 | 2 years |
| 4 | Barotac Viejo (Iloilo) | 4 | 2 years |
| 5 | City of Carcar (Cebu) | 4 | 2 years |

## Next Phase Readiness

- All JSON files ready for frontend consumption
- PSGC codes enable direct TopoJSON geographic joins
- Scores available for choropleth coloring
- Hierarchy supports drill-down navigation
- Data foundation complete; ready for Phase 02 (Static Site Generation)

## Self-Check: PASSED

All files verified:
- scripts/etl/03_calculate_scores.py: FOUND
- scripts/etl/04_generate_json.py: FOUND
- scripts/etl/validate_output.py: FOUND
- scripts/data/scores.json: FOUND
- public/data/regions.json: FOUND
- public/data/provinces/: FOUND (17 files)
- public/data/lgus/: FOUND (88 files)
- public/data/findings/: FOUND (1351 files)

All commits verified:
- fa74827: FOUND
- efecb36: FOUND
- c273237: FOUND
- 938e7ef: FOUND

---
*Phase: 01-data-foundation*
*Completed: 2026-03-16*
