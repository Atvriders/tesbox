# syntax=docker/dockerfile:1
# Build once on the runner's native platform; only the final COPY stage is per-architecture.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# Short SHA shown in the app and served in /version.json (deploy/build-sha.ts). Defaults to "dev".
# Declared after npm ci so a new SHA (every CI commit) does not invalidate the cached dependency layer.
ARG GITHUB_SHA=dev
ENV GITHUB_SHA=$GITHUB_SHA
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:alpine
# Links the GHCR package to the public repo, so it inherits the repo's (public) visibility.
LABEL org.opencontainers.image.source="https://github.com/Atvriders/tesbox"
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/security-headers.inc /etc/nginx/conf.d/security-headers.inc
COPY --from=build /app/dist /usr/share/nginx/html
# MIT notice for the adapted QR encoder (src/platform/qr.ts) ships with the bundle.
COPY NOTICES /usr/share/nginx/html/NOTICES.txt
COPY LICENSE /usr/share/nginx/html/LICENSE.txt
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/version.json > /dev/null || exit 1
