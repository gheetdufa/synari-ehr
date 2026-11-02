FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Baked into the static bundle. Use a same-origin path (/api) behind the bundled reverse proxy,
# or an absolute URL when the API is on its own domain.
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
RUN npx vite build

FROM nginx:1.31.8-alpine-slim@sha256:f45171d36c76a8b2f5ef97108a3a8a2294248a6578a0a180edc2d78f7d2edc26
# Rendered into /etc/nginx/conf.d/default.conf at startup with CSP_CONNECT_SRC filled in.
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
# Extra connect-src origins for the Content-Security-Policy (LiveKit, a separate API domain).
ENV CSP_CONNECT_SRC=""
EXPOSE 3000
