# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0] – 2026-10-27

### Added
- Step chart of one or more numeric entities with stock-style range buttons (default 1W, 1M, 3M, 6M, 1Y, All; configurable). The selected range is remembered per card in `localStorage`.
- The chart is always filled: the x axis starts at the later of range start and first data point and ends now; the y axis fits the visible values (optional `min`/`max`). Single values and empty entities are handled.
- Header with current value and change over the selected range (e.g. `−1.2 kg since 1M`), optional green/red colouring via `good_direction`.
- `change_basis: daily_mean`: change and colour compare the daily mean of the last day with the first day with data (local time zone); neutral when there is only one day.
- `trend_line: daily_mean`: bold connected line of daily means over a faded step line; the tooltip shows the day's mean.
- Crosshair tooltip for mouse and touch with value and localized date.
- Data from the recorder history (`history/history_during_period`), completed with long-term statistics (`recorder/statistics_during_period`) for periods the recorder has already purged.
- Live reload when an entity changes, theme variables (light and dark), English and German labels, no runtime dependencies, no build step.
