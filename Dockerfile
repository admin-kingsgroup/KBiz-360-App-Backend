# KBiz360 backend (MongoDB-backed: src/mongo/main.ts). Multi-stage: compile TS → run plain Node.
# Build:  docker build -t kb360-backend ./Backend
# Run:    docker run -p 4000:4000 --env-file .env.production kb360-backend

# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build              # tsc -> dist/ (includes dist/mongo/main.js)

# ---- runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Only production deps in the final image.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Local upload storage (use S3 in real production: STORAGE_DRIVER=s3).
RUN mkdir -p /app/uploads
EXPOSE 4000
# The Mongo backend entrypoint. (The Postgres/Prisma path is unused.)
CMD ["node", "dist/mongo/main.js"]
