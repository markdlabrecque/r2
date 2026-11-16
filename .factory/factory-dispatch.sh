#!/usr/bin/env bash
# Convenience wrapper; Factory owns the dispatcher.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)" || exit 1
exec factory dispatch --project "$root" "$@"
