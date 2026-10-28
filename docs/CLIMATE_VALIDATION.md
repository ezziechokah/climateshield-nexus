# Climate Engine Evidence and Validation

## Current status

The shared engine is a deterministic screening demonstration, not a validated forecast or agronomic prescription. `demo-0.2.0` includes illustrative cutoffs only; no local Kenyan dataset or expert review is represented in code. Assessments should not be used to make high-stakes planting, irrigation, pesticide, credit or insurance decisions.

## Demonstration thresholds

| Risk | Input | Current bands | Main assumptions and known omissions | Required expert review |
|---|---|---|---|---|
| Dry spell | Consecutive dry days | Moderate >=4; high >=7 | No crop stage, soil, evapotranspiration, rainfall amount threshold, or local climatology; current Open-Meteo adapter does not derive dry-day history and returns insufficient data | Define dry-day definition and period; validate crop-specific thresholds by agroecological zone; identify acceptable data source and warning lead time |
| Heavy rain | 7-day precipitation sum | Moderate >=35 mm; high >=60 mm | Not a flood forecast; no rainfall intensity, drainage, soil saturation, slope, catchment, or exposure model | Select locally justified accumulation/intensity thresholds and flood-risk limitations; validate with KMD/qualified hydrologists |
| Heat | Daily maximum temperature | Moderate >=32 C; high >=36 C | Not crop/stage specific; no duration, humidity, night temperature, water status or crop response | Validate temperature/duration thresholds by crop and growth stage with Kenyan agronomists |

Every threshold is labeled illustrative in method text. Changing a threshold requires a ruleset version change, boundary tests, evidence record and review status. Never call these validated thresholds until named experts and supporting evidence are recorded.

## Data quality

The engine checks plausible ranges and accepts a quality state. Stale, poor, contradictory and missing inputs yield `INSUFFICIENT_DATA`; invalid numerical ranges are not silently categorized. Forecast data, historical data and synthetic demonstrations are distinct records. Provider-grid weather is not an individual farm observation.

## Recommendation limits

Templates suggest monitoring soil moisture, reviewing field drainage, and considering work during cooler periods. They avoid quantities, guaranteed yields, pesticide directions and guaranteed planting dates. Localized text requires native Kiswahili review before deployment. A qualified extension officer is the escalation path when local guidance is unavailable.

## Validation plan before a pilot

1. Select crop and pilot counties with Kenyan extension/agronomy and meteorology partners.
2. Define target users, risk events, lead time and measurable false-alarm/miss costs.
3. Obtain permitted quality-controlled historical and forecast data with documented provenance.
4. Compare thresholds against independent station/field reports using temporally separated evaluation; preserve uncertainty and subgroup performance.
5. Conduct farmer comprehension testing in English/Kiswahili and accessibility testing on basic Android devices and low-connectivity networks.
6. Obtain documented expert review and governance approval before enabling any validated label.
7. Monitor drift, provider freshness and farmer-reported mismatches; provide a correction/escalation channel.

Automated tests establish deterministic code behavior only. They do not prove forecast skill, agronomic validity, farmer benefit or impact.
