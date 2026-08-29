#!/bin/bash
set -e
exec bash "$(cd "$(dirname "$0")" && pwd -P)/scripts/stop-xiaoshe-web.sh"
