# OpenAudit Philippines - Interactive Map

An interactive web visualization of audit compliance data for Philippine municipalities, built on data from the [OpenAudit](https://github.com/jerikdcruz/OpenAudit) project.

## About

OpenAudit Philippines transforms public audit reports into accessible governance data. This website visualizes Commission on Audit (COA) Annual Audit Reports from 2016-2022, showing how municipalities across the Philippines implement audit recommendations.

The project addresses an underutilized resource: publicly-available audit reports contain detailed financial and operational data about government decisions, yet remain largely inaccessible to researchers and the public. By extracting and visualizing this data, we aim to make governance metrics available to academics, journalists, and accountability advocates.

## Features

- **Interactive choropleth map** of all 86 Philippine provinces and 1,618 municipalities
- **Compliance scoring** based on audit recommendation implementation rates
- **Year filtering** - view data for individual years (2016-2022) or aggregated across all years
- **Province and municipality views** - toggle between geographic levels
- **High-resolution boundaries** from [philippines-json-maps](https://github.com/faeldon/philippines-json-maps)

## Data Source

Data is extracted from Commission on Audit (COA) Annual Audit Reports using natural language processing. Each municipality's compliance score reflects the percentage of audit recommendations that were not implemented:

- **0-20**: Very High Compliance
- **20-40**: High Compliance
- **40-60**: Moderate Compliance
- **60-80**: Low Compliance
- **80-100**: Very Low Compliance

See the [About page](https://ilkkaruso.github.io/OpenAudit-Website/about.html) for detailed methodology.

## Technology

- **Leaflet.js** for map rendering
- **GeoJSON** boundaries from PSA shapefiles via [faeldon/philippines-json-maps](https://github.com/faeldon/philippines-json-maps)
- Static site hosted on GitHub Pages / Vercel

## Local Development

```bash
# Clone the repository
git clone https://github.com/ilkkaruso/OpenAudit-Website.git
cd OpenAudit-Website

# Serve the public directory
npx serve public
# or
python -m http.server 8080 -d public
```

Open http://localhost:8080 in your browser.

## Project Structure

```
OpenAudit-Website/
├── public/
│   ├── index.html          # Main map page
│   ├── about.html          # Methodology documentation
│   ├── data.html           # Data explorer
│   ├── css/                # Stylesheets
│   ├── js/                 # JavaScript (map.js, auth.js)
│   ├── data/               # JSON score files
│   └── geo/                # GeoJSON boundaries
├── scripts/
│   ├── etl/                # Data processing scripts
│   └── geo/                # Boundary download scripts
└── README.md
```

## Related Projects

- [OpenAudit](https://github.com/jerikdcruz/OpenAudit) - Main project: NLP extraction of audit data
- [philippines-json-maps](https://github.com/faeldon/philippines-json-maps) - Philippine boundary files

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

This project is open source. Data is derived from publicly available Commission on Audit reports.
