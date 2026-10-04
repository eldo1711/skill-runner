#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-ice-cream-cone-452722}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-skills-runner}"
ACCOUNT="${ACCOUNT:-admin@jtongarm.altostrat.com}"

echo "🚀 Deploying ${SERVICE_NAME} to Cloud Run in ${PROJECT_ID} (${REGION}) as ${ACCOUNT}..."

gcloud run deploy "${SERVICE_NAME}" \
  --source . \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --account "${ACCOUNT}" \
  --allow-unauthenticated \
  --max-instances 1 \
  --memory 2Gi \
  --cpu 2 \
  --timeout 3600 \
  --set-env-vars="NODE_ENV=production,HEADLESS=true,GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_LOCATION=global" \
  --quiet
