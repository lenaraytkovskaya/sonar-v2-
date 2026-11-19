FROM node:22-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --offline --frozen-lockfile && \
    pnpm --filter @sonar/social-browser build && \
    pnpm --filter @sonar/social-browser deploy --legacy --prod /service

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /service ./
COPY --from=build /workspace/apps/social-browser/dist ./dist
ENV NODE_ENV=production DISPLAY=:99 SOCIAL_BROWSER_DATA=/data/profiles
RUN apt-get update && apt-get install -y --no-install-recommends xvfb && \
    ./node_modules/.bin/playwright install --with-deps chromium && \
    rm -rf /var/lib/apt/lists/* /root/.npm && \
    mkdir -p /data/profiles /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix && \
    chown -R node:node /app /data
RUN chmod -R a+rX /root/.cache/ms-playwright && chmod o+x /root /root/.cache
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
USER node
EXPOSE 3000 9400-9499
CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x800x24 -nolisten tcp & xvfb_pid=$!; while [ ! -S /tmp/.X11-unix/X99 ]; do sleep 0.1; done; node dist/index.js & app_pid=$!; trap 'kill -TERM \"$app_pid\" 2>/dev/null; wait \"$app_pid\"; kill -TERM \"$xvfb_pid\" 2>/dev/null; wait \"$xvfb_pid\" 2>/dev/null' TERM INT; wait \"$app_pid\""]
