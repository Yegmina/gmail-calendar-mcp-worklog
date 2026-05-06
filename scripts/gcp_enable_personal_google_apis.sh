#!/usr/bin/env bash
# Enable Gmail + Calendar + Tasks JSON APIs on GCP (requires gcloud auth and project access).
set -euo pipefail

PROJECT="${GOOGLE_CLOUD_PROJECT:-gmail-mcp-personal-495219}"

echo "Project: $PROJECT"
if ! command -v gcloud &>/dev/null; then
  echo "[skip] gcloud not installed. In Google Cloud Console enable APIs manually:"
  echo "  - Gmail API"
  echo "  - Google Calendar API"
  echo "  - Google Tasks API"
  echo "  APIs & services → Enabled APIs → + Enable APIs and services → search Calendar"
  exit 0
fi

gcloud config set project "$PROJECT" 2>/dev/null || true
gcloud services enable gmail.googleapis.com --project="$PROJECT"
gcloud services enable calendar-json.googleapis.com --project="$PROJECT"
gcloud services enable tasks.googleapis.com --project="$PROJECT"
echo "[ok] Enabled gmail.googleapis.com, calendar-json.googleapis.com, tasks.googleapis.com"
