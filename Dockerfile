FROM node:24-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm ci && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY skills ./skills
COPY pi-package ./pi-package
COPY kit ./kit
COPY docs/google-chat.md ./docs/google-chat.md
RUN chmod 755 /app/dist/cli/pots.js && ln -s /app/dist/cli/pots.js /usr/local/bin/pots
USER node
WORKDIR /home/node
CMD ["node", "/app/dist/cli/pots.js", "start"]
