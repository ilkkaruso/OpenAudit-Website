# OpenAudit Philippines

## What This Is

A public transparency website showing a "red flag" corruption index for Philippine Local Government Units (LGUs) based on COA audit data. Citizens can view an interactive map of the Philippines, see which regions and LGUs consistently fail to implement audit recommendations, and drill down to see specific findings. The site visualizes 9 years of audit data (2016-2024) covering all 17 regions.

## Core Value

Citizens can quickly see their LGU's track record on implementing audit recommendations — surfacing patterns of endemic non-compliance that indicate corruption risk.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Interactive Philippines map showing regions with color-coded red flag scores
- [ ] Drill-down from region to individual LGUs (cities/municipalities)
- [ ] Red flag index calculated using streak-based scoring (consecutive years of non-implementation)
- [ ] Click LGU to display table of audit findings sorted by worst offenders first
- [ ] Table shows: ID, Recommendation, Management Action, Status, Reason for Non-Implementation
- [ ] Year selector to filter data by audit year (2016-2024)
- [ ] Pre-processed JSON data from CSVs for static hosting
- [ ] Responsive design for mobile/desktop

### Out of Scope

- [ ] Full "CONTENT" field display — deferred to future version (too much text, needs separate UI treatment)
- [ ] Numeric financial data per LGU — deferred (data extraction needed)
- [ ] User accounts or saved searches
- [ ] Real-time data updates

## Context

**Data Source:** COA (Commission on Audit) annual audit reports for LGUs, extracted to CSV format.

**Data Structure:**
- 9 CSV files: `audit_extraction_LGU_2016.csv` through `audit_extraction_LGU_2024.csv`
- ~1.2GB total raw data
- Fields: FILENAME, ID, CONTENT, RECOMMENDATION, MANAGEMENT ACTION, STATUS OF IMPLEMENTATION, REASON FOR NON/PARTIAL IMPLEMENTATION
- ID format encodes region and LGU: `01-NCR__Cities__CaloocanCity-2024-OBS1`
- Status values: Implemented, Partially Implemented, Not Implemented, Unimplemented (various spellings)

**Geographic Coverage:**
- 17 regions (NCR, CAR, Regions I-XIII including BARMM)
- ~1,700 LGUs (cities and municipalities)

**Beta Version Notes:**
- CONTENT field preserved in data but not displayed (for future use)
- Architecture should allow adding numeric metrics per LGU later

## Constraints

- **Hosting:** Static hosting (Vercel/Netlify/GitHub Pages) — no backend server
- **Data Updates:** Annual batch updates when new COA reports released
- **Data Size:** Must pre-process ~1.2GB CSV into optimized JSON for browser performance
- **Map:** Need Philippines GeoJSON with region and LGU boundaries

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Streak-based red flag scoring | Consecutive non-implementation indicates endemic issues, not one-off failures | — Pending |
| Region-first map with drill-down | 17 regions manageable; 1,700 LGUs would overwhelm initial view | — Pending |
| Static site with pre-processed data | Annual updates mean no need for dynamic backend; reduces hosting complexity | — Pending |
| Worst offenders first in tables | Surfaces most concerning patterns for citizens checking their LGU | — Pending |

---
*Last updated: 2026-03-15 after initialization*
