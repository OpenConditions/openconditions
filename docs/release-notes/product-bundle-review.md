# Owned release review bundles

Affected versions: repository release tooling only; no product version is selected.

Action: use Product prepare and review in Actions with operation, version and reviewed notes. CI discovers machine identities, obtains pinned validators and retains the review artifact. No local tool paths or passing readiness JSON are required.

Compatibility: product descriptors, image bytes, default services, package releases and deployed schemas are unchanged.

Caveats: preparation PR automation and a trusted readiness producer are not implemented. Review artifacts can be prepared with readiness pending, but grant no publication or host-operation authority.
