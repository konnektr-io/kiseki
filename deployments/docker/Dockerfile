# ---- Stage 1: build the React SPA ----
FROM node:22-alpine AS frontend
WORKDIR /build
# pnpm-workspace.yaml carries allowBuilds (esbuild postinstall) — pnpm 11
# ignores build scripts by default and ERR_PNPM_IGNORED_BUILDS otherwise.
COPY frontend/package.json frontend/pnpm-lock.yaml* frontend/pnpm-workspace.yaml ./
RUN npm install -g pnpm@11 && pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm build

# ---- Stage 2: Python runtime with Playwright ----
FROM python:3.13-slim AS runtime
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Chromium system libraries (Playwright headless)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libasound2 libatspi2.0-0 libxshmfence1 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/pyproject.toml ./
COPY backend/app ./app
RUN pip install --no-cache-dir . \
    && python -m playwright install --with-deps chromium \
    && rm -rf /root/.cache/pip

# Built SPA → served by FastAPI from app/static
COPY --from=frontend /build/dist /app/app/static

# Non-root user — numeric UID must match the k8s securityContext (runAsUser: 1001)
RUN adduser --disabled-password --uid 1001 --gecos "" appuser \
    && chown -R appuser /app
USER appuser

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
