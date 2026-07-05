#!/usr/bin/env python3
"""
Process BLGF SRE Long Dataset 2016-2022 into JSON for the map.
Uses name-matching to map Excel data to GeoJSON PSGC codes.

Two views:
  1. Province view - provinces keyed by GeoJSON PSGC
  2. LGU view - municipalities AND cities together, keyed by GeoJSON PSGC
"""

import pandas as pd
import json
import numpy as np
import re

print("Processing BLGF SRE Long Dataset 2016-2022...")
print("=" * 60)

# Load data
xlsx_path = 'DATANEW/BLGF SRE - Long Dataset 2016-2022.xlsx'
df = pd.read_excel(xlsx_path, sheet_name=0)
print(f"Loaded {len(df)} rows")

# Load GeoJSON files
with open('public/geo/provinces.geojson') as f:
    geo_prov = json.load(f)

with open('public/geo/lgus.geojson') as f:
    geo_lgus = json.load(f)

# Identify expenditure category columns
gps_cols = [c for c in df.columns if c.startswith('GPS:')]
hnpc_cols = [c for c in df.columns if c.startswith('HNPC:')]
es_cols = [c for c in df.columns if c.startswith('ES:')]

# ============================================================
# Build GeoJSON name -> PSGC mapping
# ============================================================

def normalize_name(name):
    if not name:
        return ''
    name = str(name).strip().lower()
    name = re.sub(r'\bcity of\b', '', name)
    name = re.sub(r'\bcity\b', '', name)
    name = re.sub(r'\bprovince\b', '', name)
    # Normalize Sto./Sta. to Santo/Santa
    name = re.sub(r'\bsto\b\.?', 'santo', name)
    name = re.sub(r'\bsta\b\.?', 'santa', name)
    name = re.sub(r'[^a-z0-9\s]', '', name)
    name = re.sub(r'\s+', ' ', name).strip()
    return name

# Corrections: Excel normalized name -> GeoJSON normalized name
LGU_NAME_CORRECTIONS = {
    'ozamis': 'ozamiz',
    'baliuag': 'baliwag',
    'cordoba': 'cordova',
    'lavesares': 'lavezares',
    'pililia': 'pililla',
    'pio v corpuz': 'pio v corpus',
    'roseller t lim': 'roseller lim',
    'sanchez mira': 'sanchezmira',
    'pres carlos p garcia': 'president carlos p garcia',
    'gen s k pendatun': 'gen sk pendatun',
    'datu saudiampatuan': 'datu saudi ampatuan',
    'datu montawal': 'datu saudi ampatuan',
    'bacungan': 'leon t postigo',
}

# Province mapping
geo_prov_by_name = {}
for feat in geo_prov['features']:
    name = feat['properties'].get('name')
    psgc = str(feat['properties'].get('psgc', ''))
    if name:
        geo_prov_by_name[normalize_name(name)] = psgc
        geo_prov_by_name[name.lower().strip()] = psgc

# LGU mapping with province context
geo_lgu_by_key = {}  # "normalized_prov_name|normalized_lgu_name" -> psgc
geo_lgu_by_name_only = {}
geo_lgu_province_psgc = {}

prov_psgc_to_name = {}
for feat in geo_prov['features']:
    name = feat['properties'].get('name')
    psgc = str(feat['properties'].get('psgc', ''))
    if name:
        prov_psgc_to_name[psgc] = name

# NCR district PSGCs - map to "metro manila" for province context matching
NCR_DISTRICT_PSGCS = {'1303900000', '1307400000', '1307500000', '1307600000'}

for feat in geo_lgus['features']:
    name = feat['properties'].get('name', '')
    psgc = str(feat['properties'].get('psgc', ''))
    prov_psgc = str(feat['properties'].get('province_psgc', ''))

    if name:
        norm = normalize_name(name)
        geo_lgu_by_name_only[norm] = psgc
        geo_lgu_by_name_only[name.lower().strip()] = psgc
        geo_lgu_province_psgc[psgc] = prov_psgc

        prov_name = prov_psgc_to_name.get(prov_psgc, '')
        if prov_name:
            key = f"{normalize_name(prov_name)}|{norm}"
            geo_lgu_by_key[key] = psgc

        # Also index NCR LGUs under "metro manila" province key
        if prov_psgc in NCR_DISTRICT_PSGCS:
            key = f"metro manila|{norm}"
            geo_lgu_by_key[key] = psgc

print(f"GeoJSON: {len(geo_prov_by_name)} province entries, {len(geo_lgu_by_key)} LGU keyed entries")


def find_province_psgc(province_name):
    """Find GeoJSON PSGC for a province name"""
    norm = normalize_name(province_name)
    corrections = {
        'metro manila': 'ncr',
        'north cotabato': 'cotabato',
    }
    for try_name in [norm, province_name.lower().strip(), corrections.get(norm, '')]:
        if try_name and try_name in geo_prov_by_name:
            return geo_prov_by_name[try_name]
    # Partial match
    for geo_name, geo_code in geo_prov_by_name.items():
        if norm and (norm in geo_name or geo_name in norm):
            return geo_code
    return None


PROVINCE_NAME_CORRECTIONS = {
    'north cotabato': 'cotabato',
    'metro manila': 'metro manila',  # handled by NCR district keys
}

def find_lgu_psgc(lgu_name, province_name):
    """Find GeoJSON PSGC for a municipality/city"""
    norm_lgu = normalize_name(lgu_name)
    norm_prov = normalize_name(province_name)

    # Apply spelling corrections
    corrected_lgu = LGU_NAME_CORRECTIONS.get(norm_lgu, norm_lgu)
    corrected_prov = PROVINCE_NAME_CORRECTIONS.get(norm_prov, norm_prov)

    # Try province|lgu combined key first (with all name variants)
    prov_variants = list(dict.fromkeys([norm_prov, corrected_prov]))
    lgu_variants = list(dict.fromkeys([norm_lgu, corrected_lgu]))

    for try_prov in prov_variants:
        for try_lgu in lgu_variants:
            key = f"{try_prov}|{try_lgu}"
            if key in geo_lgu_by_key:
                return geo_lgu_by_key[key]

    # Try name-only (with both original and corrected)
    for try_name in [norm_lgu, corrected_lgu, lgu_name.lower().strip()]:
        if try_name in geo_lgu_by_name_only:
            return geo_lgu_by_name_only[try_name]

    # Try partial match with province context
    for try_prov in prov_variants:
        for geo_key, geo_psgc in geo_lgu_by_key.items():
            geo_prov_part, geo_lgu_part = geo_key.split('|', 1)
            if geo_prov_part == try_prov:
                if corrected_lgu in geo_lgu_part or geo_lgu_part in corrected_lgu:
                    return geo_psgc

    return None


def aggregate_group(group, gps_cols, hnpc_cols, es_cols):
    """Aggregate a group of rows (same LGU, multiple years) into a single record."""
    years_disallow = {}
    years_op_exp = {}
    years_local_sources = {}
    years_op_income = {}
    years_gps = {}
    years_hnpc = {}
    years_es = {}
    total_records = 0

    for _, row in group.iterrows():
        year = str(int(row['YEAR']))

        dis = row['DIS_ND_Ending_Balance']
        if pd.notna(dis) and dis > 0:
            years_disallow[year] = years_disallow.get(year, 0) + float(dis)

        op_exp = row['SRE_TOTAL_CURRENT_OPERATING_EXPENDITURES']
        if pd.notna(op_exp) and op_exp > 0:
            years_op_exp[year] = float(op_exp)

        local_src = row['SRE_TOTAL_LOCAL_SOURCES']
        if pd.notna(local_src) and local_src > 0:
            years_local_sources[year] = float(local_src)

        op_income = row['SRE_TOTAL_CURRENT_OPERATING_INCOME']
        if pd.notna(op_income) and op_income > 0:
            years_op_income[year] = float(op_income)

        gps_total = sum(float(row[c]) for c in gps_cols if pd.notna(row[c]) and row[c] > 0)
        hnpc_total = sum(float(row[c]) for c in hnpc_cols if pd.notna(row[c]) and row[c] > 0)
        es_total = sum(float(row[c]) for c in es_cols if pd.notna(row[c]) and row[c] > 0)

        if gps_total > 0:
            years_gps[year] = gps_total
        if hnpc_total > 0:
            years_hnpc[year] = hnpc_total
        if es_total > 0:
            years_es[year] = es_total

        rec_count = row['DIS_Record_Count']
        if pd.notna(rec_count):
            total_records += int(rec_count)

    total_disallowances = sum(years_disallow.values())
    total_op_exp = sum(years_op_exp.values())
    total_local_sources = sum(years_local_sources.values())
    total_op_income = sum(years_op_income.values())

    ratio_exp = (total_disallowances / total_op_exp * 100) if total_op_exp > 0 else 0
    ratio_local = (total_disallowances / total_local_sources * 100) if total_local_sources > 0 else 0

    # True average of per-year ratios (weights each year equally)
    all_years = sorted(set(list(years_disallow.keys()) + list(years_op_exp.keys()) + list(years_local_sources.keys())))
    yearly_ratios_exp = []
    yearly_ratios_local = []
    for yr in all_years:
        dis = years_disallow.get(yr, 0)
        exp = years_op_exp.get(yr, 0)
        local = years_local_sources.get(yr, 0)
        if exp > 0:
            yearly_ratios_exp.append(dis / exp * 100)
        if local > 0:
            yearly_ratios_local.append(dis / local * 100)

    true_avg_ratio_exp = float(np.mean(yearly_ratios_exp)) if yearly_ratios_exp else 0
    true_avg_ratio_local = float(np.mean(yearly_ratios_local)) if yearly_ratios_local else 0

    return {
        'totalDisallowances': total_disallowances,
        'total_operating_income': total_op_income,
        'total_operating_expenditures': total_op_exp,
        'total_local_sources': total_local_sources,
        'disallowance_ratio_percent': ratio_exp,
        'ratio_vs_local_sources': ratio_local,
        'true_avg_ratio_exp': true_avg_ratio_exp,
        'true_avg_ratio_local': true_avg_ratio_local,
        'yearsWithData': len(years_disallow),
        'observationCount': total_records,
        'years': years_disallow,
        'operating_exp_by_year': years_op_exp,
        'local_sources_by_year': years_local_sources,
        'operating_income_by_year': years_op_income,
        'gps_by_year': years_gps,
        'hnpc_by_year': years_hnpc,
        'es_by_year': years_es,
        'avgDisallowances': float(np.mean(list(years_disallow.values()))) if years_disallow else 0,
        'avgOperatingExpenditures': float(np.mean(list(years_op_exp.values()))) if years_op_exp else 0,
        'avgLocalSources': float(np.mean(list(years_local_sources.values()))) if years_local_sources else 0,
    }


# ============================================================
# Process provinces
# ============================================================

print("\n--- Processing Provinces ---")

prov_df = df[df['SRE_LGU_TYPE'] == 'Province'].copy()
provinces_data = {}
prov_matched = 0

for province_name, group in prov_df.groupby('PROVINCE'):
    geo_psgc = find_province_psgc(province_name)

    if geo_psgc:
        prov_matched += 1
    else:
        code = str(int(group.iloc[0]['CODE']))
        geo_psgc = code.ljust(10, '0')

    record = aggregate_group(group, gps_cols, hnpc_cols, es_cols)
    record['name'] = province_name

    # Count LGUs
    lgu_count = len(df[(df['PROVINCE'] == province_name) &
                       (df['SRE_LGU_TYPE'].isin(['Municipality', 'City']))]['LGU NAME'].unique())
    record['lguCount'] = lgu_count

    # Avg per LGU
    if lgu_count > 0 and record['totalDisallowances'] > 0:
        record['avgDisallowancesPerLGU'] = record['totalDisallowances'] / lgu_count

    provinces_data[geo_psgc] = record

prov_with_data = sum(1 for p in provinces_data.values() if p['totalDisallowances'] > 0)
print(f"Provinces: {len(provinces_data)} total, {prov_matched} matched to GeoJSON, {prov_with_data} with disallowance data")

# ============================================================
# Process LGUs (Municipalities + Cities)
# ============================================================

print("\n--- Processing LGUs (Municipalities + Cities) ---")

lgu_df = df[df['SRE_LGU_TYPE'].isin(['Municipality', 'City'])].copy()
lgus_data = {}
lgu_matched_count = 0

for (province_name, lgu_name), group in lgu_df.groupby(['PROVINCE', 'LGU NAME']):
    lgu_type = group.iloc[0]['SRE_LGU_TYPE']
    geo_psgc = find_lgu_psgc(lgu_name, province_name)

    if geo_psgc:
        lgu_matched_count += 1
    else:
        code = str(int(group.iloc[0]['CODE']))
        geo_psgc = code.ljust(10, '0')

    record = aggregate_group(group, gps_cols, hnpc_cols, es_cols)
    record['name'] = lgu_name
    record['province'] = province_name
    record['lguType'] = lgu_type

    lgus_data[geo_psgc] = record

cities_count = sum(1 for l in lgus_data.values() if l.get('lguType') == 'City')
mun_count = sum(1 for l in lgus_data.values() if l.get('lguType') == 'Municipality')
lgus_with_data = sum(1 for l in lgus_data.values() if l['totalDisallowances'] > 0)
print(f"LGUs: {len(lgus_data)} total ({mun_count} municipalities, {cities_count} cities)")
print(f"LGUs matched to GeoJSON: {lgu_matched_count}")
print(f"LGUs with disallowance data: {lgus_with_data}")

# ============================================================
# Save output
# ============================================================

output = {
    'description': 'COA Disallowances and SRE Financial Data by LGU (2016-2022)',
    'lastUpdated': '2025-07-05',
    'dataSource': 'BLGF SRE - Long Dataset 2016-2022',
    'summary': {
        'totalProvinces': len(provinces_data),
        'totalLGUs': len(lgus_data),
        'totalCities': cities_count,
        'totalMunicipalities': mun_count,
        'years': [2016, 2017, 2018, 2019, 2020, 2021, 2022]
    },
    'provinces': provinces_data,
    'lgus': lgus_data
}

# Convert numpy types
def convert_types(obj):
    if isinstance(obj, dict):
        return {k: convert_types(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [convert_types(v) for v in obj]
    elif isinstance(obj, (np.integer,)):
        return int(obj)
    elif isinstance(obj, (np.floating,)):
        return float(obj)
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    return obj

output = convert_types(output)

with open('public/data/disallowances_with_yearly.json', 'w') as f:
    json.dump(output, f, indent=2)

print(f"\n✅ Saved to public/data/disallowances_with_yearly.json")

# ============================================================
# Verification
# ============================================================

print("\n--- Verification ---")

geo_prov_psgcs = set(str(f['properties'].get('psgc', '')) for f in geo_prov['features'])
geo_lgu_psgcs = set(str(f['properties'].get('psgc', '')) for f in geo_lgus['features'])

prov_geo_matched = sum(1 for p in provinces_data if p in geo_prov_psgcs)
lgu_geo_matched = sum(1 for l in lgus_data if l in geo_lgu_psgcs)

print(f"Province PSGC matches with GeoJSON: {prov_geo_matched}/{len(geo_prov['features'])}")
print(f"LGU PSGC matches with GeoJSON: {lgu_geo_matched}/{len(geo_lgus['features'])}")

print("\nSample provinces:")
for psgc, prov in list(provinces_data.items())[:5]:
    tag = "✓" if psgc in geo_prov_psgcs else "✗"
    print(f"  {tag} {prov['name']} ({psgc}): disallow=₱{prov['totalDisallowances']:,.0f}, ratio={prov['disallowance_ratio_percent']:.2f}%")

print("\nSample LGUs:")
for psgc, lgu in list(lgus_data.items())[:5]:
    tag = "✓" if psgc in geo_lgu_psgcs else "✗"
    print(f"  {tag} {lgu['name']} [{lgu['lguType']}] ({psgc}): disallow=₱{lgu['totalDisallowances']:,.0f}")
