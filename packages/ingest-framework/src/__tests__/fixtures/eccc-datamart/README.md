# ECCC Datamart directory listings

Apache index pages (HTML, stored as `.txt` so the linter leaves the served markup alone) of the
ECCC Datamart CAP alert tree, captured 2026-10-08 and trimmed to the entries the walk tests need
(headers, the parent link and the sort links kept as served).

- `day.txt`: https://dd.weather.gc.ca/20261008/WXO-DD/alerts/cap/20261008/ (offices trimmed to `CWTO/`)
- `office.txt`: https://dd.weather.gc.ca/20261008/WXO-DD/alerts/cap/20261008/CWTO/ (hours trimmed to `18/`, `19/`)
- `hour-18.txt`: https://dd.weather.gc.ca/20261008/WXO-DD/alerts/cap/20261008/CWTO/18/ (files trimmed to two)
- `hour-19.txt`: https://dd.weather.gc.ca/20261008/WXO-DD/alerts/cap/20261008/CWTO/19/ (files trimmed to two)

The tests construct the later states from these (an hour's changed modification time, an added
file, a link to another host or to the parent); those cases are built in the test, not captured.
