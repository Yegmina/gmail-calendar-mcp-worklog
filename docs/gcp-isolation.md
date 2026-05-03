# GCP: keep billing / production projects separate

- Do **not** use the StudyShorts Pay / Google Play verification GCP project (`studyshortspayservice`) for personal Gmail MCP unless you explicitly intend to.
- **Gmail MCP** and personal integrations should live in a **dedicated** GCP project (example id: `gmail-mcp-personal-495219`, display name *Gmail MCP Personal*).
- OAuth client IDs for Cursor’s hosted `gmail` MCP should come from that dedicated project’s Google Auth Platform / Credentials, not from unrelated products.
