#!/bin/bash
# One-shot test of the Apify LinkedIn profile scraper.
#
# Usage:
#   APIFY_TOKEN=apify_api_xxx ./test-apify.sh andriibobchuk
#   APIFY_TOKEN=apify_api_xxx ./test-apify.sh https://linkedin.com/in/andriibobchuk
#   APIFY_TOKEN=apify_api_xxx ./test-apify.sh                # defaults to andriibobchuk
#
# Cost per run: ~$0.005 (well under the $5 free monthly credit).

set -e

if [ -z "$APIFY_TOKEN" ]; then
  echo "Error: APIFY_TOKEN not set."
  echo ""
  echo "1. Sign up at https://apify.com/sign-up (no card required)"
  echo "2. Copy your API token from https://console.apify.com/account/integrations"
  echo "3. Run:  APIFY_TOKEN=apify_api_xxx ./test-apify.sh"
  exit 1
fi

INPUT="${1:-andriibobchuk}"

# The actor accepts a username, a full URL, or a URN.
# We pass it through as-is.
PAYLOAD=$(printf '{"username":"%s","includeEmail":false}' "$INPUT")

ACTOR="apimaestro~linkedin-profile-detail"
ENDPOINT="https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${APIFY_TOKEN}"

echo "Fetching LinkedIn profile: $INPUT"
echo "Cost: ~\$0.005 (billed to your Apify credit)"
echo "Waiting for scraper (typically 10-30s)..."
echo ""

RESPONSE=$(curl -sS --max-time 90 -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

# Pretty-print if jq is available, otherwise print raw.
if command -v jq >/dev/null 2>&1; then
  echo "$RESPONSE" | jq .
else
  echo "$RESPONSE"
  echo ""
  echo "(Tip: install jq with 'brew install jq' for pretty-printed output.)"
fi
