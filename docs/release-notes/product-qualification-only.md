# Publication is unavailable during the qualification transition

The old tag/dispatch workflow that published packages, images and extension assets is retired from the current source. Creating a version tag no longer selects the current source's publisher. Existing releases, tags and registry images are unchanged.

The replacement Product qualification workflow is manual and read-only. It validates native image evidence and merged manifest inputs, then uploads an expiring qualification receipt. It cannot prepare a PR, create a tag or release, push an image, advance a channel or deploy a host. Package publication is not implemented here.

Publication remains unavailable until separately reviewed mutation stages, host/readiness evidence, approval and native safeguards are implemented and qualified. Historical workflow definitions remain in Git history; source deletion alone does not qualify native protections against invoking historical refs. Do not use historical workflows as a workaround for this transition. See the product release guide for the remaining gates.
