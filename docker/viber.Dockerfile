FROM node:22-bookworm-slim AS compile
WORKDIR /app
RUN npm install --global typescript@5.9.3 @types/node@22
COPY apps/viber-bridge/tsconfig.json ./apps/viber-bridge/tsconfig.json
COPY apps/viber-bridge/package.json ./apps/viber-bridge/package.json
COPY apps/viber-bridge/src/index.ts ./apps/viber-bridge/src/index.ts
COPY apps/viber-bridge/src/database.ts ./apps/viber-bridge/src/database.ts
COPY apps/viber-bridge/src/missing-key.ts ./apps/viber-bridge/src/missing-key.ts
COPY apps/viber-bridge/src/screen.ts ./apps/viber-bridge/src/screen.ts
COPY apps/viber-bridge/src/send.ts ./apps/viber-bridge/src/send.ts
COPY apps/viber-bridge/src/supervisor.ts ./apps/viber-bridge/src/supervisor.ts
RUN tsc -p apps/viber-bridge/tsconfig.json --typeRoots /usr/local/lib/node_modules/@types

FROM node:22-bookworm-slim
ARG VIBER_VERSION=29.4.0.7
ARG VIBER_SHA256=34b3c18f5d441a9813066811d037e971e1207d439c246766abd28e185a7ecd37
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xvfb xdotool openbox dbus-x11 imagemagick sqlite3 tesseract-ocr tesseract-ocr-ukr tesseract-ocr-rus tesseract-ocr-eng fonts-dejavu xdg-utils && \
    curl --fail --location https://download.cdn.viber.com/cdn/desktop/Linux/viber.deb --output /tmp/viber.deb && \
    echo "$VIBER_SHA256  /tmp/viber.deb" | sha256sum --check - && \
    test "$(dpkg-deb --field /tmp/viber.deb Version)" = "$VIBER_VERSION" && \
    apt-get install -y /tmp/viber.deb && rm -rf /tmp/viber.deb /var/lib/apt/lists/* && \
    mkdir /data && chown node:node /data
RUN apt-get update && apt-get install -y --no-install-recommends xclip && rm -rf /var/lib/apt/lists/* && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
ENV HOME=/data DISPLAY=:99 LANG=C.UTF-8 QT_QPA_PLATFORM=xcb QT_OPENGL=software LIBGL_ALWAYS_SOFTWARE=1 VIBER_DESKTOP_VERSION=29.4.0.7
WORKDIR /app
COPY --from=compile /app/apps/viber-bridge/dist ./dist
COPY apps/viber-bridge/package.json ./package.json
USER node
EXPOSE 3000
CMD ["sh", "-c", "export DBUS_SESSION_BUS_ADDRESS=\"$(dbus-daemon --session --fork --print-address=1)\"; exec node dist/index.js"]
