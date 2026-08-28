#!/bin/bash

# Test script for rate limiting on auth endpoints
# Usage: ./test-rate-limit.sh
# Verifies X-RateLimit-Limit / Remaining / Reset on success and 429 responses.

API_URL="http://localhost:3000/api/v1"
TEST_ADDRESS="GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"

print_rate_headers() {
  local headers="$1"
  echo "$headers" | grep -iE '^(HTTP/|X-RateLimit-|Retry-After:)' || true
}

echo "=========================================="
echo "Testing Rate Limiting on Auth Endpoints"
echo "=========================================="
echo ""

echo "1. Testing GET /auth/nonce (limit: 5 per minute)"
echo "--------------------------------------------------"
for i in {1..7}; do
  echo "Request $i:"
  HEADERS=$(mktemp)
  BODY=$(curl -s -D "$HEADERS" -o - \
    "${API_URL}/auth/nonce?address=${TEST_ADDRESS}")
  print_rate_headers "$(cat "$HEADERS")"
  echo "$BODY" | jq -C '.' 2>/dev/null || echo "$BODY"
  rm -f "$HEADERS"
  echo ""
  sleep 1
done

echo ""
echo "2. Testing POST /auth/login (limit: 10 per minute)"
echo "---------------------------------------------------"
for i in {1..12}; do
  echo "Request $i:"
  HEADERS=$(mktemp)
  BODY=$(curl -s -D "$HEADERS" -o - \
    -X POST "${API_URL}/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"stellarAddress\":\"${TEST_ADDRESS}\",\"signature\":\"test\",\"signedNonce\":\"test\"}")
  print_rate_headers "$(cat "$HEADERS")"
  echo "$BODY" | jq -C '.' 2>/dev/null || echo "$BODY"
  rm -f "$HEADERS"
  echo ""
  sleep 1
done

echo ""
echo "=========================================="
echo "Test Complete"
echo "=========================================="
echo ""
echo "Expected behavior:"
echo "- Successful responses include X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset"
echo "- Nonce endpoint: First 5 requests succeed, 6th and 7th return 429"
echo "- On 429: X-RateLimit-Remaining=0 and X-RateLimit-Reset / Retry-After indicate retry window"
echo "- Login endpoint: First 10 requests fail with 401 (invalid signature),"
echo "  11th and 12th return 429 (rate limited) with the same rate-limit headers"
echo ""
