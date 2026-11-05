# Protected product publication source

Affected versions: Future product review candidates; no version is chosen or published by this change.

Action: Use the existing prepare/review workflow and inspect its publication blockers. No additional run IDs, digests or passing JSON are operator inputs.

Compatibility: Validation stays read-only and preparation PR creation stays isolated. The separate publication job requires the named protected environment; its eligibility is currently false because full execution authority and a supported native immutability preflight are missing.

Caveats: Owned HTTP/Git/OCI tests establish source mechanics only. Native environment/registry acceptance, actual prior-deployment upgrade, complete readiness and deliberate publication remain pending. No existing history, latest or stable channel is changed.
