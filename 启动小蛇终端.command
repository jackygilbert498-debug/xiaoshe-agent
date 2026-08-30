#!/bin/bash
set -e
exec bash "$(cd "$(dirname "$0")" && pwd -P)/scripts/start-xiaoshe-terminal.sh" "$@"
