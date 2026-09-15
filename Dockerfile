# SideStage backend — one image with Node, Postgres client libs and a real
# Chrome. Chrome is not optional: eBay Live streams nothing to Playwright's
# headless shell, and the watcher, discovery and show preparation all drive a
# real browser against the seller's signed-in profile (data/ebay-profile).
FROM mcr.microsoft.com/playwright:v1.63.0-noble

RUN apt-get update \
 && apt-get install -y --no-install-recommends wget gnupg ca-certificates \
 && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -rf /tmp/chrome.deb /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# tsx is a dev dependency and the runtime; install everything.
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY docs ./docs
COPY fixtures ./fixtures

# Chrome will not run as root without --no-sandbox; the image ships pwuser
# (uid 1000, the same as the host's ubuntu user that owns the mounted data).
RUN mkdir -p /app/data && chown -R pwuser:pwuser /app
USER pwuser

ENV NODE_ENV=production PORT=8790
EXPOSE 8790
# The app runs from source via tsx, as `npm start` does locally.
CMD ["npx", "tsx", "src/index.ts"]
