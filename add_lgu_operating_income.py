#!/usr/bin/env python3
"""
Script to add Total Current Operating Income data from SRE files to disallowances.json
This enables calculation of true disallowance ratios for all LGUs
"""

import pandas as pd
import json
import re
from pathlib import Path

def normalize_lgu_name(name):
    """Normalize LGU names for matching"""
    if pd.isna(name) or name is None:
        return ""

    name = str(name).upper().strip()

    # Remove common prefixes
    prefixes = ['CITY OF ', 'MUNICIPALITY OF ', 'PROVINCE OF ']
    for prefix in prefixes:
        if name.startswith(prefix):
            name = name[len(prefix):]

    # Remove parenthetical content
    name = re.sub(r'\([^)]*\)', '', name).strip()

    # Remove special characters but keep spaces for now
    name = re.sub(r'[^\w\s]', '', name)

    # Remove extra spaces
    name = ' '.join(name.split())

    return name

def extract_sre_data(year):
    """Extract LGU operating income data from SRE file"""
    file_path = f'disallowances/By-LGU-SRE-{year}.xlsx'

    if not Path(file_path).exists():
        print(f"File not found: {file_path}")
        return {}

    print(f"Processing {year} SRE data...")

    # Read the Excel file without headers
    df = pd.read_excel(file_path, header=None)

    # Find the column index for 'TOTAL CURRENT OPERATING INCOME'
    income_col_idx = None
    for i in range(10):
        row = df.iloc[i]
        for j, val in enumerate(row):
            if pd.notna(val) and 'TOTAL CURRENT OPERATING INCOME' in str(val):
                income_col_idx = j
                break
        if income_col_idx:
            break

    if not income_col_idx:
        print(f"  Warning: Could not find income column for {year}")
        return {}

    # Extract data starting from row 17
    lgu_income = {}
    data_rows = df.iloc[17:]

    for _, row in data_rows.iterrows():
        region = row[1] if pd.notna(row[1]) else None
        province = row[2] if pd.notna(row[2]) else None
        lgu = row[3] if pd.notna(row[3]) else None
        income = row[income_col_idx] if pd.notna(row[income_col_idx]) else 0

        if lgu and income > 0:
            # Create a key similar to what's in disallowances.json
            lgu_normalized = normalize_lgu_name(lgu)
            if province:
                province_normalized = normalize_lgu_name(province)
                key = f"{province_normalized}_{lgu_normalized}"
                lgu_income[key] = {
                    'lgu_name': lgu,
                    'province': province,
                    'region': region,
                    'total_operating_income': float(income),
                    'year': year
                }

    print(f"  Extracted {len(lgu_income)} LGUs with income data")
    return lgu_income

def main():
    """Main function to update disallowances.json with operating income data"""

    # Load existing disallowances data
    with open('public/data/disallowances.json', 'r') as f:
        data = json.load(f)

    lgus = data.get('lgus', {})
    print(f"Loaded {len(lgus)} LGUs from disallowances.json")

    # Process all years
    years = [2016, 2017, 2018, 2019, 2020, 2021, 2022]
    all_income_data = {}

    for year in years:
        year_data = extract_sre_data(year)

        # Merge year data into all_income_data
        for key, value in year_data.items():
            if key not in all_income_data:
                all_income_data[key] = {}
            all_income_data[key][year] = value['total_operating_income']

    print(f"\nTotal unique LGUs with income data: {len(all_income_data)}")

    # Update LGUs in disallowances.json
    matched = 0
    updated = 0

    for lgu_key, lgu_data in lgus.items():
        # Try different matching strategies
        lgu_name = lgu_data.get('name', '')
        province = lgu_data.get('province', '')

        # Try exact match first
        match_keys = [
            f"{normalize_lgu_name(province)}_{normalize_lgu_name(lgu_name)}",
            f"{province}_{lgu_name}",
            lgu_name,
            normalize_lgu_name(lgu_name)
        ]

        for match_key in match_keys:
            if match_key in all_income_data:
                matched += 1

                # Calculate average income across years
                income_by_year = all_income_data[match_key]
                total_income = sum(income_by_year.values())
                years_with_data = len(income_by_year)
                avg_income = total_income / years_with_data if years_with_data > 0 else 0

                # Add income data to LGU
                lgu_data['total_operating_income'] = round(avg_income, 2)
                lgu_data['income_years'] = list(income_by_year.keys())
                lgu_data['income_by_year'] = income_by_year

                # Calculate proper disallowance ratio if we have both values
                if avg_income > 0 and lgu_data.get('totalDisallowances', 0) > 0:
                    ratio = (lgu_data['totalDisallowances'] / avg_income) * 100
                    lgu_data['calculated_ratio_percent'] = round(ratio, 4)
                    updated += 1

                break

    print(f"\nMatched {matched}/{len(lgus)} LGUs")
    print(f"Updated {updated} LGUs with calculated ratios")

    # Save updated data
    output_file = 'public/data/disallowances_with_income.json'
    with open(output_file, 'w') as f:
        json.dump(data, f, indent=2)

    print(f"\nSaved updated data to {output_file}")

    # Show some examples
    print("\nSample updated LGUs:")
    sample_count = 0
    for key, lgu in lgus.items():
        if 'total_operating_income' in lgu and 'calculated_ratio_percent' in lgu:
            print(f"  {lgu['name']} ({lgu['province']})")
            print(f"    Total Disallowances: ₱{lgu['totalDisallowances']:,.2f}")
            print(f"    Total Operating Income: ₱{lgu['total_operating_income']:,.2f}")
            print(f"    Calculated Ratio: {lgu['calculated_ratio_percent']:.2f}%")
            sample_count += 1
            if sample_count >= 3:
                break

if __name__ == "__main__":
    main()