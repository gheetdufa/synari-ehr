FROM node:26.9.0-alpine@sha256:dbaa92e5758cbbcf85d65d5403fdb530fe3442cbe8c6dbfb7ef23365450d5070 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Baked into the static bundle. Use a same-origin path (/api) behind the bundled reverse proxy,
# or an absolute URL when the API is on its own domain.
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
RUN npx vite build

FROM nginx:1.30.5-alpine-slim@sha256:32463212baf0e7d91aded2e9b843a4f2b9e017804b8c9d5bae7b51dcef64389c
# Rendered into /etc/nginx/conf.d/default.conf at startup with CSP_CONNECT_SRC filled in.
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
# Extra connect-src origins for the Content-Security-Policy (LiveKit, a separate API domain).
ENV CSP_CONNECT_SRC=""
EXPOSE 3000
