#!/bin/sh
# Real child-process boundary test; no provider requests.
[ -z "${GITHUB_TOKEN:-}${GH_TOKEN:-}${GITHUB_OUTPUT:-}${GITHUB_STEP_SUMMARY:-}" ] || exit 99
printf 200
