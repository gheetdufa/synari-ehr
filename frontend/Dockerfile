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

FROM nginx:1.31.6-alpine-slim@sha256:f761b94f2cb9e8e05e2943d5f773609596113ef69b54e2433a996d109a8f78b7
# Rendered into /etc/nginx/conf.d/default.conf at startup with CSP_CONNECT_SRC filled in.
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
# Extra connect-src origins for the Content-Security-Policy (LiveKit, a separate API domain).
ENV CSP_CONNECT_SRC=""
EXPOSE 3000
