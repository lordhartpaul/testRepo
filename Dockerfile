# Build stage: compile TypeScript with the dev dependencies present.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY src ./src
COPY test ./test
RUN npm run build

# Runtime stage: the compiled output only, no dependencies at all.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY examples ./examples
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/api/server.js"]
