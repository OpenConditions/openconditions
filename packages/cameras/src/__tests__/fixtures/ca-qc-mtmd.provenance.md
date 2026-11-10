# Québec MTMD inventory fixture

Four unchanged feature rows from the official EPSG:4326 WFS export, retrieved on 2026-11-07. The collection count was reduced from 683 to 4 and the collection bounding box removed to make this an explicit test subset. Row geometry, identity, optional fields and external link values are unchanged. The full response and HTTP headers are retained in the task receipt outside the repository.

Source: https://ws.mapserver.transports.gouv.qc.ca/swtq?service=wfs&version=2.0.0&request=getfeature&typename=ms:infos_cameras&outfile=Camera&srsname=EPSG:4326&outputformat=geojson

Credit: Ministère des Transports et de la Mobilité durable, “Caméra de circulation”, Données Québec. Metadata licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), as declared by the [dataset](https://www.donneesquebec.ca/recherche/dataset/camera-de-circulation). Modified by subset selection and normalization; no endorsement implied.

`DateDebutDiffusion` is each entry’s publication-start date and is retained in the fixture only. It is never interpreted as an observation or image time. Dataset resource and package modification dates lack timezone designators and are not converted to UTC. Retrieval is a separate event, recorded in the task receipt; parser freshness records retrieval only. Empty border names remain absent from normalized records; no border identity is inferred.

The supplied HTML URLs are ordinary external detail links. The dataset licence does not qualify rights in their player content. No image, stream, thumbnail, embed or media request was made. A previously researched detail-page HTTP 403 provides no playback qualification. Count agreement describes this export, not a permanent provincial camera census. Daily polling and the existing snapshot shrink guards remain in force. Fixture and local API tests do not establish sustained source health or authorize production activation.
