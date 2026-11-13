FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --offline --frozen-lockfile && pnpm build
RUN pnpm --filter @sonar/worker deploy --legacy --prod /worker

FROM node:22-slim AS web
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

FROM node:22-slim AS browser
# Shared Chromium headless shell for public social pages and website forms.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build /worker/node_modules/playwright/package.json /tmp/playwright.json
RUN PLAYWRIGHT_VERSION=$(node -p "require('/tmp/playwright.json').version") && npx --yes "playwright@$PLAYWRIGHT_VERSION" install --with-deps --only-shell chromium && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/playwright.json && chmod -R a+rX /ms-playwright

FROM browser AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /worker ./
USER node
CMD ["node", "dist/index.js"]
