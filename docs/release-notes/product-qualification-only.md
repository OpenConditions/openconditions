# Publication is unavailable during the qualification transition

Affected versions: Source checkouts containing the publisher-retirement change; no new product version is assigned. Existing releases, tags, registry images and deployed hosts are unchanged.

Action: Use the manual Product qualification workflow only to validate native image evidence and merged manifest inputs. Publication remains unavailable until separately reviewed mutation stages, host/readiness evidence, approval and native safeguards are implemented and qualified.

Compatibility: The old tag/dispatch publisher is retired from current source. The read-only replacement uploads an expiring qualification receipt; it cannot prepare a PR, create a tag or release, push an image, publish a package, advance a channel or deploy a host.

Caveats: Historical workflow definitions remain in Git history. Source deletion alone does not qualify native protections against invoking historical refs; do not use those workflows as a workaround. See the product release guide for the remaining gates.
