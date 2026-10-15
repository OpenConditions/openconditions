# Vehicle fixtures

Live capture taken on 2026-10-14 at 23:24:56 UTC with
`curl -sS -m 90 --compressed`, the headers `Digitraffic-User: OpenConditions/1.0`
and `Accept-Encoding: gzip`, and no credentials. It is off season: the answer
held 22 trackings, all on state roads, none of them ploughing or salting. JSON
was re-indented, which writes Digitraffic's `54.00` as `54.0`.

| File                                     | Source and licence                                                                                                         | Records kept                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fi-digitraffic-maintenance-latest.json` | Fintraffic Digitraffic, https://tie.digitraffic.fi/api/maintenance/v1/tracking/routes/latest?domain=state-roads, CC BY 4.0 | 11 of 22, unedited: 202634237 (`LINE_SANDING`, 47 minutes old), 202634372 (`OTHER`, direction 0), 202634841 (`ROAD_STATE_CHECKING`, 15 minutes old), 202634992 (direction 288), 202635001 (no direction), 202635025 (`SPOT_SANDING`), 202635027 (`BRUSHING`), 202635031 (`SNOW_PLOUGHING_STICKS_AND_SNOW_FENCES`, direction 5), 202635032 (`LEVELLING_GRAVEL_ROAD_SURFACE`), 202635037 (`BRUSH_CLEARING`), 202635043 (a time with milliseconds); the collection header |
| `fi-digitraffic-maintenance-edges.json`  | Edited from tracking 202635031 of the same capture                                                                         | Eight made-up trackings (ids 900000001 to 900000008) for what the off-season answer lacks: ploughing with spot sanding (direction 359), salting, no `tasks` field, a task code the list does not hold and no `direction` field, `UNKNOWN` with direction 360, a `LineString`, a position at 0,0, and an unreadable time                                                                                                                                                |

The task codes and their Finnish, Swedish and English names are those of
https://tie.digitraffic.fi/api/maintenance/v1/tracking/tasks on the same day
(47 codes).
